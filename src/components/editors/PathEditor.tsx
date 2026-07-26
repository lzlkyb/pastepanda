import { useState, useMemo } from "react";
import { FileText, FolderOpen, Copy } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/** 路径形状拆解结果 */
interface PathParts {
  /** 根："C:\" / "\\server\share" / "/" / null（相对路径） */
  root: string | null;
  /** 根之后的各段 */
  segments: string[];
  /** 最后一段（可能为 null） */
  last: string | null;
  kind: "file" | "folder" | "unc" | "relative";
  /** 扩展名（含点，如 ".csv"；目录/无扩展名为 null） */
  ext: string | null;
}

/** 按形状拆解 Windows/Unix/UNC/相对路径（纯展示用，不做存在性判断） */
function splitPathParts(raw: string): PathParts {
  const text = raw;
  const hasTrailingSep = /[\\/]\s*$/.test(text);
  const segs = text.split(/[\\/]+/).filter(Boolean);

  let root: string | null = null;
  let rest = segs;
  let unc = false;

  if (/^[A-Za-z]:$/.test(segs[0] ?? "")) {
    // 盘符路径：C:\...（按分隔符切开后 "C:" 独立成段）
    root = segs[0] + "\\";
    rest = segs.slice(1);
  } else if (/^\\\\/.test(text) || /^\/\//.test(text)) {
    // UNC：\\server\share
    unc = true;
    const server = segs[0] ?? "";
    const share = segs[1];
    root = share ? `\\\\${server}\\${share}` : `\\\\${server}`;
    rest = segs.slice(share ? 2 : 1);
  } else if (/^[\\/]/.test(text)) {
    root = "/";
  }

  const last = rest.length > 0 ? rest[rest.length - 1] : null;
  const extMatch = last && !hasTrailingSep ? /\.([^.]+)$/.exec(last) : null;
  const ext = extMatch ? "." + extMatch[1].toLowerCase() : null;

  let kind: PathParts["kind"];
  if (unc) kind = "unc";
  else if (!root) kind = "relative";
  else if (hasTrailingSep || rest.length === 0 || !ext) kind = "folder";
  else kind = "file";

  return { root, segments: rest, last, kind, ext };
}

/**
 * 路径专用编辑器（C 方案）：面包屑拆解 + 资源管理器动作。
 * - 上半部把路径拆成面包屑芯片（文件名高亮），状态徽章区分 文件/文件夹/UNC/相对路径；
 * - 动作行复用后端命令：open_file_with_system（用默认应用打开）/
 *   open_file_location（在资源管理器中显示），均自带存在性检查与网络路径拦截；
 * - 下半部保留可编辑文本区与标准变换工具栏。
 */
export function PathEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  // 多行时仅取首行做形状拆解（路径卡片本身是单行，编辑中误输入换行不致 UI 错乱）
  const clean = useMemo(() => text.trim().split(/\r?\n/)[0] ?? "", [text]);
  const parts = useMemo(() => splitPathParts(clean), [clean]);
  const fileLike = (parts.kind === "file" || parts.kind === "unc" || parts.kind === "relative") && !!parts.ext;

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  const kindBadge = (() => {
    if (parts.kind === "unc") return parts.ext ? `🌐 UNC · ${parts.ext}` : "🌐 UNC 路径";
    if (parts.kind === "relative") return parts.ext ? `➿ 相对 · ${parts.ext}` : "➿ 相对路径";
    if (parts.kind === "folder") return "📁 文件夹";
    return `📄 文件 · ${parts.ext}`;
  })();

  const openFile = async () => {
    try {
      await invoke("open_file_with_system", { path: clean });
      toast(`已打开 ${parts.last ?? "文件"}`, "success");
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件", "error");
    }
  };

  const revealInExplorer = async () => {
    try {
      await invoke("open_file_location", { path: clean });
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    }
  };

  const copyFileName = async () => {
    if (!parts.last) return;
    try {
      await navigator.clipboard.writeText(parts.last);
      toast("已复制文件名", "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="📁 路径"
        status={<span className="path-kind-badge">{kindBadge}</span>}
      />

      {/* 面包屑拆解卡片 */}
      <div className="url-struct">
        {clean ? (
          <div className="path-crumbs">
            {parts.root && (
              <>
                <span className="path-crumb path-crumb-root">{parts.root}</span>
                {parts.segments.length > 0 && <span className="path-crumb-sep">›</span>}
              </>
            )}
            {parts.segments.map((seg, i) => {
              const isLast = i === parts.segments.length - 1;
              return (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <span className={`path-crumb${isLast && fileLike ? " path-crumb-file" : ""}`}>{seg}</span>
                  {!isLast && <span className="path-crumb-sep">›</span>}
                </span>
              );
            })}
          </div>
        ) : (
          <span className="path-empty-hint">路径为空 — 在下方输入后自动拆解</span>
        )}
      </div>

      {/* 动作行（复用 FileDetailDialog 已验证的后端命令） */}
      <div className="editor-actions">
        <ToolBtn accent icon={<FileText size={13} />} label="打开文件" onClick={openFile} />
        <ToolBtn icon={<FolderOpen size={13} />} label="在资源管理器中显示" onClick={revealInExplorer} />
        <ToolBtn icon={<Copy size={13} />} label="复制文件名" onClick={copyFileName} />
      </div>

      <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

      <TransformToolbar
        text={text}
        transform={transform}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={false}
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
