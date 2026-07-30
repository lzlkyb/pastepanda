import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { motion } from "framer-motion";
import { X, FolderOpen, Copy, ExternalLink, Loader, Check } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { relativeTime } from "@/lib/utils";
import SourceBadge from "@/components/SourceBadge";
import { HistoryItem } from "@/stores/appStore";
import { getFileIcon, getFileIconColor } from "@/lib/source-mappings";
import { parseFilePaths } from "@/lib/pasteTransform";
import { getImageDataUrl } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";

// 预加载 Tauri API 模块
let _invoke: any = null;
let _openUrl: any = null;
const preloadApi = async () => {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke;
  }
  if (!_openUrl) {
    const opener = await import("@tauri-apps/plugin-opener");
    _openUrl = opener.openUrl;
  }
};

type FileMeta = { size: number; exists: boolean };
type TextPreviewData = {
  kind: "text" | "binary" | "missing";
  file_size: number;
  total_lines: number;
  lines: string[];
  truncated: boolean;
  extension: string;
};

const IMAGE_EXT_SET = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"]);
const extOf = (p: string) => {
  const m = p.match(/\.([^.\\/]*)$/);
  return (m?.[1] || "").toLowerCase();
};
const isImageFile = (p: string) => IMAGE_EXT_SET.has(extOf(p));

const formatSize = (bytes: number) => {
  if (!bytes || bytes === 0) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
};

const nameOf = (p: string) => p.split(/[\\/]/).pop() || p;

export function FileDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const anim = useDialogAnim();
  // 多文件支持：content 可能是 JSON 数组 / 换行分隔的多路径，也可能是单路径。
  const paths = useMemo(() => {
    const p = parseFilePaths(item?.content || "");
    return p.length > 0 ? p : (item?.content ? [item.content] : []);
  }, [item?.content]);
  const isMulti = paths.length > 1;
  const time = relativeTime(item.time);

  // ④ 快速预览共享状态：单文件模式默认选中唯一路径，多文件模式默认选中第一个。
  const [previewPath, setPreviewPath] = useState<string>(paths[0] || "");
  const [previewData, setPreviewData] = useState<TextPreviewData | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!paths.length) { setPreviewPath(""); return; }
    if (!paths.includes(previewPath)) setPreviewPath(paths[0]);
  }, [paths, previewPath]);

  useEffect(() => {
    setPreviewData(null);
    setImagePreviewUrl("");
    if (!previewPath) return;
    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      try {
        if (isImageFile(previewPath)) {
          const url = await getImageDataUrl(previewPath);
          if (!cancelled) setImagePreviewUrl(url || "");
        } else {
          const { invoke } = await import("@tauri-apps/api/core");
          const data = await invoke<TextPreviewData>("read_text_file_preview", { path: previewPath });
          if (!cancelled) setPreviewData(data);
        }
      } catch {
        if (!cancelled) setPreviewData(null);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [previewPath]);

  // U51：Esc 关闭 + 向全局键盘层广播开关状态
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("app-filedetail-open"));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.dispatchEvent(new CustomEvent("app-filedetail-close"));
    };
  }, [onClose]);

  if (!item) return null;

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box ${isMulti ? "w420" : "w380"}`}
        onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">{isMulti ? `📁 文件详情 · ${paths.length} 个文件` : "文件详情"}</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          {isMulti
            ? <MultiFileBody paths={paths} item={item} onSelectPreview={setPreviewPath} selectedPath={previewPath} />
            : <SingleFileBody path={paths[0] || item.content || ""} item={item} />}

          {/* ④ 快速预览 */}
          <PreviewPanel
            path={previewPath}
            data={previewData}
            imageUrl={imagePreviewUrl}
            loading={previewLoading}
          />

          {/* Footer */}
          <div className="dialog-footer">
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{time}</span>
            <button className="btn-primary" onClick={onClose}>关闭</button>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
  );
}

/** ④ 快速预览面板：图片缩略图 / 文本前 N 行（带行号）/ 二进制或不存在占位 */
function PreviewPanel({ path, data, imageUrl, loading }: {
  path: string; data: TextPreviewData | null; imageUrl: string; loading: boolean;
}) {
  const { toast } = useToast();
  if (!path) return null;

  const isImage = isImageFile(path);
  const copyPreview = async () => {
    if (!data || data.kind !== "text") return;
    try {
      await navigator.clipboard.writeText(data.lines.join("\n"));
      toast("预览文本已复制", "success");
    } catch { toast("复制失败", "error"); }
  };

  return (
    <div className="file-preview-panel">
      <div className="file-preview-head">
        <span className="file-preview-label">快速预览</span>
        {data?.kind === "text" && data.lines.length > 0 && (
          <button className="file-preview-copy" onClick={copyPreview} title="复制预览文本">
            <Copy size={12} /> 复制
          </button>
        )}
      </div>

      {loading && (
        <div className="file-preview-loading">
          <Loader size={13} className="spin" /> 加载预览…
        </div>
      )}

      {!loading && isImage && (
        imageUrl
          ? (
            <div className="file-preview-img-wrap">
              <img src={imageUrl} alt={nameOf(path)} className="file-preview-img" />
            </div>
          )
          : <div className="file-preview-empty">无法加载图片预览</div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length > 0 && (
        <>
          <div className="file-preview-code-wrap">
            <pre className="file-preview-code">
              <code>
                {data.lines.map((line, i) => (
                  <div key={i} className="file-preview-line">
                    <span className="file-preview-ln">{i + 1}</span>
                    <span className="file-preview-txt">{line || " "}</span>
                  </div>
                ))}
              </code>
            </pre>
          </div>
          <div className="file-preview-meta">
            <span>共 {data.total_lines} 行</span>
            {data.extension && <span className="file-preview-ext">.{data.extension}</span>}
            {data.truncated && <span className="file-preview-truncated">仅预览前部分</span>}
          </div>
        </>
      )}

      {!loading && !isImage && data?.kind === "binary" && (
        <div className="file-preview-empty">
          <span>🧩 二进制文件 · {formatSize(data.file_size)}</span>
        </div>
      )}

      {!loading && !isImage && data?.kind === "missing" && (
        <div className="file-preview-empty">文件不存在或已移动</div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length === 0 && (
        <div className="file-preview-empty">空文件</div>
      )}
    </div>
  );
}

/** 单文件主体（保留原有布局；path 为解析后的真实路径） */
function SingleFileBody({ path, item }: { path: string; item: HistoryItem }) {
  const { toast } = useToast();
  const [fileInfo, setFileInfo] = useState<FileMeta | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => {
    preloadApi().then(() => setApiReady(true));
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<FileMeta>("get_file_info", { path });
        if (!cancelled) setFileInfo(info);
      } catch {
        if (!cancelled) setFileInfo({ size: 0, exists: false });
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  const fileName = nameOf(path);
  const fileExists = fileInfo?.exists === true;
  const fileMissing = fileInfo?.exists === false;
  const fileIcon = getFileIcon(fileName);
  const iconColor = getFileIconColor(fileName);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast("路径已复制", "success");
    } catch { toast("复制失败", "error"); }
  }, [path, toast]);

  const handleOpenFile = useCallback(async () => {
    if (openingFile || !fileExists) return;
    setOpeningFile(true);
    try {
      await preloadApi();
      await _invoke("open_file_with_system", { path });
      toast(`已打开 ${fileName}`, "success");
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件", "error");
    } finally {
      setOpeningFile(false);
    }
  }, [path, openingFile, fileExists, fileName, toast]);

  const handleOpenFolder = useCallback(async () => {
    if (openingFolder || !fileExists) return;
    setOpeningFolder(true);
    try {
      await preloadApi();
      await _invoke("open_file_location", { path });
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    } finally {
      setOpeningFolder(false);
    }
  }, [path, openingFolder, fileExists, toast]);

  return (
    <div className="dialog-body" style={{ "--dialog-body-gap": "16px" } as React.CSSProperties}>
      {/* 文件图标 + 名称 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: iconColor,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22, flexShrink: 0,
        }}>{fileIcon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fileName}
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: fileMissing ? "var(--danger, #EF4444)" : "var(--text-muted)" }}>
            {fileInfo === null ? "检查中…" : fileExists ? <><Check size={12} style={{marginRight:2,color:"var(--green)"}} /> 文件正常</> : "⚠ 文件不存在或已移动"}
          </div>
        </div>
      </div>

      {/* 信息列表 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <InfoRow label="完整路径" value={path} mono />
        <InfoRow label="文件大小" value={fileInfo ? formatSize(fileInfo.size) : "…"} />
        <InfoRow label="复制时间" value={item.time || "未知"} />
        <InfoRow label="来源" value={item.source ? <SourceBadge source={item.source} /> : "未知"} />
      </div>

      {/* 操作按钮 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <FileActionBtn
          icon={openingFile ? <Loader size={14} className="spin" /> : <ExternalLink size={14} />}
          label={openingFile ? "打开中…" : "打开文件"}
          onClick={handleOpenFile}
          primary
          disabled={!fileExists || openingFile || !apiReady}
        />
        <FileActionBtn
          icon={openingFolder ? <Loader size={14} className="spin" /> : <FolderOpen size={14} />}
          label={openingFolder ? "打开中…" : "打开文件夹"}
          onClick={handleOpenFolder}
          disabled={!fileExists || openingFolder || !apiReady}
        />
        <FileActionBtn
          icon={<Copy size={14} />}
          label="复制路径"
          onClick={handleCopyPath}
        />
      </div>
    </div>
  );
}

/** 多文件主体：汇总信息 + 可滚动文件列表（逐文件状态与操作，行点击触发预览）+ 批量操作 */
function MultiFileBody({ paths, item, onSelectPreview, selectedPath }: {
  paths: string[]; item: HistoryItem; onSelectPreview: (p: string) => void; selectedPath: string;
}) {
  const { toast } = useToast();
  const [infoMap, setInfoMap] = useState<Record<string, FileMeta>>({});
  const [apiReady, setApiReady] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    preloadApi().then(() => setApiReady(true));
    let cancelled = false;
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await Promise.all(paths.map(async (p) => {
        try {
          const info = await invoke<FileMeta>("get_file_info", { path: p });
          return [p, info] as const;
        } catch {
          return [p, { size: 0, exists: false }] as const;
        }
      }));
      if (!cancelled) setInfoMap(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [paths]);

  const loaded = Object.keys(infoMap).length > 0;
  const okCount = paths.filter((p) => infoMap[p]?.exists).length;
  const missingCount = paths.length - okCount;
  const totalSize = paths.reduce((s, p) => s + (infoMap[p]?.exists ? infoMap[p].size : 0), 0);

  const openFile = useCallback(async (p: string) => {
    if (busyPath) return;
    setBusyPath(p);
    try {
      await preloadApi();
      await _invoke("open_file_with_system", { path: p });
      toast(`已打开 ${nameOf(p)}`, "success");
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件", "error");
    } finally {
      setBusyPath(null);
    }
  }, [busyPath, toast]);

  const openFolder = useCallback(async (p: string) => {
    if (busyPath) return;
    setBusyPath(p);
    try {
      await preloadApi();
      await _invoke("open_file_location", { path: p });
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    } finally {
      setBusyPath(null);
    }
  }, [busyPath, toast]);

  const copyPath = useCallback(async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      toast("路径已复制", "success");
    } catch { toast("复制失败", "error"); }
  }, [toast]);

  const copyAllPaths = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      toast(`已复制 ${paths.length} 个路径`, "success");
    } catch { toast("复制失败", "error"); }
  }, [paths, toast]);

  const openAllFolders = useCallback(async () => {
    const existing = paths.filter((p) => infoMap[p]?.exists);
    if (existing.length === 0) { toast("没有可打开的文件", "error"); return; }
    const dirs = new Set(existing.map((p) => {
      const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      return idx >= 0 ? p.slice(0, idx) : p;
    }));
    try {
      await preloadApi();
      let opened = 0;
      for (const p of existing) {
        const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        const dir = idx >= 0 ? p.slice(0, idx) : p;
        if (dirs.has(dir)) {
          dirs.delete(dir);
          await _invoke("open_file_location", { path: p });
          opened++;
        }
      }
      toast(`已打开 ${opened} 个文件夹`, "success");
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    }
  }, [paths, infoMap, toast]);

  return (
    <div className="dialog-body" style={{ "--dialog-body-gap": "12px" } as React.CSSProperties}>
      {/* 汇总信息 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "10px 12px", borderRadius: 10, background: "var(--section-bg)",
      }}>
        <span style={{ fontSize: 18 }}>🗂</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{paths.length} 个文件</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>共 {loaded ? formatSize(totalSize) : "…"}</span>
        {loaded && (
          <>
            <span style={{ fontSize: 11, color: "var(--green)" }}>✓ {okCount} 正常</span>
            {missingCount > 0 && <span style={{ fontSize: 11, color: "var(--danger, #EF4444)" }}>⚠ {missingCount} 已移动</span>}
          </>
        )}
        <span style={{ marginLeft: "auto" }}>
          {item.source ? <SourceBadge source={item.source} /> : null}
        </span>
      </div>

      {/* 文件列表（点击行切换预览） */}
      <div style={{
        display: "flex", flexDirection: "column", gap: 6,
        maxHeight: 300, overflowY: "auto", paddingRight: 2,
      }}>
        {paths.map((p) => {
          const info = infoMap[p];
          const exists = info?.exists === true;
          const missing = info?.exists === false;
          const name = nameOf(p);
          const busy = busyPath === p;
          const isSelected = p === selectedPath;
          return (
            <div
              key={p}
              onClick={() => onSelectPreview(p)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectPreview(p); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                borderRadius: 10, cursor: "pointer",
                border: `1px solid ${isSelected ? "var(--accent)" : "var(--border-color)"}`,
                background: isSelected ? "color-mix(in srgb, var(--accent) 8%, var(--card-bg))" : "var(--card-bg)",
                transition: "border-color 0.15s, background 0.15s",
              }}>
              <div style={{
                width: 34, height: 34, borderRadius: 9, background: getFileIconColor(name),
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
              }}>{getFileIcon(name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p}>
                  {name}
                </div>
                <div style={{ fontSize: 10.5, marginTop: 1, color: missing ? "var(--danger, #EF4444)" : "var(--text-muted)" }}>
                  {!info ? "检查中…" : exists ? `${formatSize(info.size)} · 正常` : "⚠ 已移动或不存在"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <RowIconBtn title="打开文件" disabled={!exists || busy || !apiReady} onClick={(e) => { e.stopPropagation(); openFile(p); }}>
                  {busy ? <Loader size={13} className="spin" /> : <ExternalLink size={13} />}
                </RowIconBtn>
                <RowIconBtn title="打开文件夹" disabled={!exists || busy || !apiReady} onClick={(e) => { e.stopPropagation(); openFolder(p); }}>
                  <FolderOpen size={13} />
                </RowIconBtn>
                <RowIconBtn title="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(p); }}>
                  <Copy size={13} />
                </RowIconBtn>
              </div>
            </div>
          );
        })}
      </div>

      {/* 批量操作 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <FileActionBtn
          icon={<FolderOpen size={14} />}
          label="打开全部文件夹"
          onClick={openAllFolders}
          primary
          disabled={!loaded || okCount === 0 || !apiReady}
        />
        <FileActionBtn
          icon={<Copy size={14} />}
          label="复制全部路径"
          onClick={copyAllPaths}
        />
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0, minWidth: 60 }}>{label}</span>
      <span style={{
        fontSize: 12, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-all",
        fontFamily: mono ? "'SF Mono', Consolas, monospace" : "inherit",
        lineHeight: 1.5,
      }}>{value}</span>
    </div>
  );
}

function FileActionBtn({ icon, label, onClick, primary, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; primary?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
      border: primary ? "none" : "1px solid var(--border-color)",
      background: primary ? (disabled ? "var(--text-muted)" : "var(--accent)") : "var(--card-bg)",
      color: primary ? "#fff" : (disabled ? "var(--text-muted)" : "var(--text-secondary)"),
      fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
      boxShadow: primary && !disabled ? "0 2px 8px rgba(0,120,212,0.25)" : "none",
      opacity: disabled ? 0.5 : 1,
    }}>
      {icon}{label}
    </button>
  );
}

/** 文件行内的小型图标按钮 */
function RowIconBtn({ title, onClick, disabled, children }: {
  title: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
      border: "1px solid var(--border-color)", background: "var(--card-bg)",
      color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      transition: "all 0.15s",
    }}>
      {children}
    </button>
  );
}
