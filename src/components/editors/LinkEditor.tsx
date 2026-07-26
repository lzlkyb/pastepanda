import { useState, useMemo } from "react";
import { Globe, Copy, Link2, FolderOpen } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import { splitUrlParts, fileUrlToLocalPath, parseUrl } from "@/lib/url";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 链接专用编辑器（C 方案）：URL 结构拆解 + 一键动作。
 * - 上半部把 URL 拆成 协议 / 域名 / 路径 / 参数 / 锚点，参数以 key=value 芯片展示；
 * - 动作行：打开浏览器 / 复制域名 / 复制路径；
 * - 非法 URL 时结构卡片降级为提示条，动作行仅保留复制；
 * - 下半部保留可编辑文本区与标准变换工具栏。
 */
export function LinkEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const parts = useMemo(() => splitUrlParts(text), [text]);
  const isFileUrl = useMemo(() => parseUrl(text.trim())?.protocol === "file:", [text]);

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  const copyPart = async (value: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast(`已复制${label}`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  // file:// 链接 opener 插件默认白名单不放行，改走后端 open_file_with_system
  // （自带存在性检查与网络共享拦截，中文路径经 fileUrlToLocalPath 解码还原）
  const openTarget = async () => {
    try {
      if (isFileUrl) {
        const localPath = fileUrlToLocalPath(text);
        if (!localPath) throw new Error("无法解析本地路径");
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_file_with_system", { path: localPath });
      } else {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(text.trim());
      }
    } catch (e) {
      toast("打开失败: " + String(e), "error");
    }
  };

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="🔗 链接"
        status={
          parts ? (
            <span className="link-valid-badge">✓ 合法 URL</span>
          ) : (
            <span className="link-invalid-badge">✗ 非法 URL</span>
          )
        }
      />

      {parts ? (
        <>
          {/* URL 结构拆解卡片 */}
          <div className="url-struct">
            <div className="url-row">
              <span className="url-label">协议</span>
              <span className="url-chip url-chip-proto">{parts.protocol}</span>
              <span className="url-host">{parts.host}</span>
            </div>
            {parts.pathSegments.length > 0 && (
              <div className="url-row">
                <span className="url-label">路径</span>
                <span className="url-path">
                  {parts.pathSegments.map((seg, i) => (
                    <span key={i}>
                      <span className="url-seg-dim">/</span>
                      {seg}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {parts.query.length > 0 && (
              <div className="url-row">
                <span className="url-label">参数</span>
                {parts.query.map(([k, v], i) => (
                  <span className="url-qchip" key={i}>
                    <b>{k}</b>
                    <span>{v}</span>
                  </span>
                ))}
              </div>
            )}
            {parts.hash && (
              <div className="url-row">
                <span className="url-label">锚点</span>
                <span className="url-chip url-chip-hash">{parts.hash}</span>
              </div>
            )}
          </div>

          {/* 动作行 */}
          <div className="editor-actions">
            <ToolBtn
              accent
              icon={isFileUrl ? <FolderOpen size={13} /> : <Globe size={13} />}
              label={isFileUrl ? "用默认应用打开" : "打开浏览器"}
              onClick={openTarget}
            />
            <ToolBtn icon={<Copy size={13} />} label="复制域名" onClick={() => copyPart(parts.host, "域名")} />
            <ToolBtn
              icon={<Copy size={13} />}
              label="复制路径"
              onClick={() => copyPart("/" + parts.pathSegments.join("/"), "路径")}
            />
          </div>
        </>
      ) : (
        <div className="url-invalid-note">
          <Link2 size={13} />
          无法解析为合法 URL — 可直接编辑下方文本，修正后自动恢复结构拆解
        </div>
      )}

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
