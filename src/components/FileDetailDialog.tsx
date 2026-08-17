import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { X, FolderOpen, Copy, ExternalLink, Loader, Check, Search, Maximize2, ChevronDown } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { relativeTime, errText, highlightCode } from "@/lib/utils";
import SourceBadge from "@/components/SourceBadge";
import { HistoryItem } from "@/stores/appStore";
import { getFileIcon, getFileIconColor } from "@/lib/source-mappings";
import { parseFilePaths } from "@/lib/utils";
import { getImageDataUrl } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogStore } from "@/stores/dialogStore";

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

/** 文本文件 → 全屏编辑器 contentType 映射（与 FullscreenEditor 注册表对齐） */
const TEXT_CONTENT_TYPE: Record<string, string> = {
  md: "markdown", markdown: "markdown", json: "json",
  html: "html", htm: "html", csv: "csv", tsv: "csv", log: "log", txt: "text",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rs: "code",
  go: "code", java: "code", c: "code", cpp: "code", sh: "shell", yml: "code",
  yaml: "code", xml: "code", css: "code", sql: "code",
};
const textContentType = (ext: string) => TEXT_CONTENT_TYPE[ext] || "text";

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
  const [metaOpen, setMetaOpen] = useState(false);

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
        className={`dialog-box w420 fd-dialog`}
        onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">{isMulti ? `📁 文件详情 · ${paths.length} 个文件` : "📁 文件详情"}</h2>
            <button className="dialog-close" onClick={onClose}><X size={16} /></button>
          </div>

          {isMulti
            ? <MultiFileBody paths={paths} item={item} onSelectPreview={setPreviewPath} selectedPath={previewPath} />
            : <SingleFileBody path={paths[0] || item.content || ""} item={item} metaOpen={metaOpen} setMetaOpen={setMetaOpen} />}

          {/* ④ 快速预览 —— 改为占据主区（flex:1） */}
          <PreviewPanel
            path={previewPath}
            data={previewData}
            imageUrl={imagePreviewUrl}
            loading={previewLoading}
            item={item}
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

/** ④ 快速预览面板（主区版）：图片 hero / 文本高亮+搜索+复制全文+编辑器打开 / 二进制·缺失引导 */
function PreviewPanel({ path, data, imageUrl, loading, item }: {
  path: string; data: TextPreviewData | null; imageUrl: string; loading: boolean; item: HistoryItem;
}) {
  const { toast } = useToast();
  const openEditor = useDialogStore((s) => s.openEditor);
  const isImage = isImageFile(path);

  const enlargeImage = useCallback(() => {
    openEditor({ ...item, id: `${item.id}-img`, type: "image", content: path } as HistoryItem);
  }, [openEditor, item, path]);

  const openSys = useCallback(async () => {
    try { await invoke("open_file_with_system", { path }); }
    catch (e) { toast(errText(e, "无法打开文件"), "error"); }
  }, [path, toast]);

  const openLoc = useCallback(async () => {
    try { await invoke("open_file_location", { path }); }
    catch (e) { toast(errText(e, "无法打开文件夹"), "error"); }
  }, [path, toast]);

  if (!path) return null;

  return (
    <div className="file-preview-panel fd-preview">
      {loading && (
        <div className="file-preview-loading">
          <Loader size={13} className="spin" /> 加载预览…
        </div>
      )}

      {!loading && isImage && imageUrl && (
        <div className="file-preview-img-hero">
          <img src={imageUrl} alt={nameOf(path)} className="file-preview-img-big" onClick={enlargeImage} />
          <button className="file-preview-enlarge" onClick={enlargeImage} title="点击放大查看">
            <Maximize2 size={14} /> 放大查看
          </button>
        </div>
      )}

      {!loading && isImage && !imageUrl && (
        <div className="file-preview-empty fd-empty">
          <span>无法加载图片预览</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统打开" onClick={openSys} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length > 0 && (
        <TextPreviewBody data={data} path={path} />
      )}

      {!loading && !isImage && data?.kind === "binary" && (
        <div className="file-preview-empty fd-empty">
          <span>🧩 二进制文件 · {formatSize(data.file_size)}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>无法内联预览，可在系统中打开查看</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统打开" onClick={openSys} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "missing" && (
        <div className="file-preview-empty fd-empty">
          <span style={{ color: "var(--danger, #EF4444)" }}>⚠ 文件不存在或已移动</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>可打开原所在文件夹确认</span>
          <FileActionBtn icon={<FolderOpen size={14} />} label="打开所在文件夹" onClick={openLoc} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length === 0 && (
        <div className="file-preview-empty fd-empty">空文件</div>
      )}
    </div>
  );
}

/** 文本预览主体：语法高亮 + 行号 + 面板内搜索 + 复制全文 + 编辑器打开 */
function TextPreviewBody({ data, path }: { data: TextPreviewData; path: string }) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [highlightHtml, setHighlightHtml] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const lines = data.lines;

  // 语法高亮（异步，Shiki；失败/无高亮回退纯文本）
  useEffect(() => {
    let cancelled = false;
    highlightCode(lines.join("\n"))
      .then((r) => { if (!cancelled) setHighlightHtml(r.html || ""); })
      .catch(() => { if (!cancelled) setHighlightHtml(""); });
    return () => { cancelled = true; };
  }, [lines]);

  // 注入 data-line 以便搜索高亮命中行（容忍 class="line" 带空格/额外属性）
  const processedHtml = useMemo(() => {
    if (!highlightHtml) return "";
    let i = 0;
    return highlightHtml.replace(/<span class="line"[^>]*>/g, (m) => m.replace(/<span class="line"/, `<span class="line" data-line="${++i}"`));
  }, [highlightHtml]);

  const matchLines = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    const res: number[] = [];
    lines.forEach((ln, i) => { if (ln.toLowerCase().includes(q)) res.push(i); });
    return res;
  }, [query, lines]);

  // 命中行高亮 + 滚动到当前命中
  useEffect(() => {
    const root = codeRef.current;
    if (!root) return;
    root.querySelectorAll(".line").forEach((el) => el.classList.remove("search-hit", "search-active"));
    if (!query || matchLines.length === 0) return;
    const idx = matchLines[Math.min(activeMatch, matchLines.length - 1)];
    matchLines.forEach((li) => {
      const el = root.querySelector(`.line[data-line="${li + 1}"]`);
      if (el) el.classList.add("search-hit");
    });
    const activeEl = root.querySelector(`.line[data-line="${idx + 1}"]`) as HTMLElement | null;
    if (activeEl) { activeEl.classList.add("search-active"); activeEl.scrollIntoView({ block: "center" }); }
  }, [query, matchLines, activeMatch, processedHtml]);

  // Ctrl/Cmd+F 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copyFull = useCallback(async () => {
    try {
      const full = await invoke<string>("read_text_file_full", { path });
      await navigator.clipboard.writeText(full);
      toast("已复制全文", "success");
    } catch { toast("复制失败", "error"); }
  }, [path, toast]);

  const openInEditor = useCallback(() => {
    invoke("open_fullscreen_editor", { filePath: path, contentType: textContentType(data.extension) }).catch(() => {});
  }, [path, data.extension]);

  const nextMatch = useCallback(() => {
    if (matchLines.length) setActiveMatch((m) => (m + 1) % matchLines.length);
  }, [matchLines.length]);
  const prevMatch = useCallback(() => {
    if (matchLines.length) setActiveMatch((m) => (m - 1 + matchLines.length) % matchLines.length);
  }, [matchLines.length]);

  return (
    <>
      <div className="file-preview-toolbar">
        <button className="fpt-btn" onClick={copyFull} title="复制文件全文"><Copy size={12} /> 复制全文</button>
        <button className="fpt-btn" onClick={openInEditor} title="在编辑器中打开"><ExternalLink size={12} /> 编辑器打开</button>
        <button className="fpt-btn" onClick={() => { setShowSearch((s) => !s); setTimeout(() => searchInputRef.current?.focus(), 0); }} title="搜索 (Ctrl+F)"><Search size={12} /> 搜索</button>
        {showSearch && (
          <span className="file-search">
            <input
              ref={searchInputRef}
              value={query}
              placeholder="搜索…"
              onChange={(e) => { setQuery(e.target.value); setActiveMatch(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) prevMatch();
                  else nextMatch();
                }
              }}
            />
            <span className="file-search-count">{matchLines.length ? `${Math.min(activeMatch + 1, matchLines.length)}/${matchLines.length}` : "0"}</span>
            <button onClick={prevMatch} title="上一个">↑</button>
            <button onClick={nextMatch} title="下一个">↓</button>
          </span>
        )}
      </div>

      <div className="file-preview-code-wrap">
        {processedHtml ? (
          <pre className="file-preview-code shiki-code" ref={codeRef}>
            <code dangerouslySetInnerHTML={{ __html: processedHtml }} />
          </pre>
        ) : (
          <pre className="file-preview-code" ref={codeRef}>
            <code>
              {lines.map((line, i) => (
                <div key={i} className="file-preview-line">
                  <span className="file-preview-ln">{i + 1}</span>
                  <span className="file-preview-txt">{renderPlainLine(line, query)}</span>
                </div>
              ))}
            </code>
          </pre>
        )}
      </div>

      <div className="file-preview-meta">
        <span>共 {data.total_lines} 行</span>
        {data.extension && <span className="file-preview-ext">.{data.extension}</span>}
        {data.truncated && <span className="file-preview-truncated">仅预览前部分</span>}
      </div>
    </>
  );
}

/** 纯文本分支：在命中行内高亮匹配子串 */
function renderPlainLine(line: string, query: string): ReactNode {
  if (!query) return line || " ";
  const lower = line.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let idx = 0;
  while ((idx = lower.indexOf(q, from)) !== -1) {
    if (idx > from) parts.push(line.slice(from, idx));
    parts.push(<mark key={from} className="file-search-hit">{line.slice(idx, idx + q.length)}</mark>);
    from = idx + q.length;
  }
  if (from < line.length) parts.push(line.slice(from));
  return parts.length ? parts : (line || " ");
}

/** 单文件主体：元信息收进可折叠紧凑条，预览占主区 */
function SingleFileBody({ path, item, metaOpen, setMetaOpen }: {
  path: string; item: HistoryItem; metaOpen: boolean; setMetaOpen: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [fileInfo, setFileInfo] = useState<FileMeta | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
      await invoke("open_file_with_system", { path });
      toast(`已打开 ${fileName}`, "success");
    } catch (e) {
      toast(errText(e, "无法打开文件"), "error");
    } finally {
      setOpeningFile(false);
    }
  }, [path, openingFile, fileExists, fileName, toast]);

  const handleOpenFolder = useCallback(async () => {
    if (openingFolder || !fileExists) return;
    setOpeningFolder(true);
    try {
      await invoke("open_file_location", { path });
    } catch (e) {
      toast(errText(e, "无法打开文件夹"), "error");
    } finally {
      setOpeningFolder(false);
    }
  }, [path, openingFolder, fileExists, toast]);

  return (
    <div className="fd-body">
      {/* 可折叠紧凑条 */}
      <div
        className="fd-strip"
        role="button"
        tabIndex={0}
        onClick={() => setMetaOpen(!metaOpen)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setMetaOpen(!metaOpen); }}>
        <div className="fd-strip-icon" style={{ background: iconColor }}>{fileIcon}</div>
        <div className="fd-strip-main">
          <div className="fd-strip-name" title={fileName}>{fileName}</div>
          <div className="fd-strip-sub">
            {fileInfo === null
              ? "检查中…"
              : fileExists
                ? <><Check size={11} style={{ marginRight: 2, color: "var(--green)" }} /> 文件正常</>
                : "⚠ 已移动或不存在"}
          </div>
        </div>
        <ChevronDown size={16} className={`fd-strip-chev ${metaOpen ? "open" : ""}`} />
      </div>

      {metaOpen && (
        <>
          <div className="fd-info-rows">
            <InfoRow label="完整路径" value={path} mono />
            <InfoRow label="文件大小" value={fileInfo ? formatSize(fileInfo.size) : "…"} />
            <InfoRow label="复制时间" value={item.time || "未知"} />
            <InfoRow label="来源" value={item.source ? <SourceBadge source={item.source} /> : "未知"} />
          </div>
          <div className="fd-actions">
            <FileActionBtn
              icon={openingFile ? <Loader size={14} className="spin" /> : <ExternalLink size={14} />}
              label={openingFile ? "打开中…" : "打开文件"}
              onClick={handleOpenFile}
              primary
              disabled={!fileExists || openingFile}
            />
            <FileActionBtn
              icon={openingFolder ? <Loader size={14} className="spin" /> : <FolderOpen size={14} />}
              label={openingFolder ? "打开中…" : "打开文件夹"}
              onClick={handleOpenFolder}
              disabled={!fileExists || openingFolder}
            />
            <FileActionBtn icon={<Copy size={14} />} label="复制路径" onClick={handleCopyPath} />
          </div>
        </>
      )}
    </div>
  );
}

/** 多文件主体：汇总信息 + 可滚动文件列表（逐文件状态与操作，行点击触发预览）+ 批量操作 */
function MultiFileBody({ paths, item, onSelectPreview, selectedPath }: {
  paths: string[]; item: HistoryItem; onSelectPreview: (p: string) => void; selectedPath: string;
}) {
  const { toast } = useToast();
  const [infoMap, setInfoMap] = useState<Record<string, FileMeta>>({});
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
      await invoke("open_file_with_system", { path: p });
      toast(`已打开 ${nameOf(p)}`, "success");
    } catch (e) {
      toast(errText(e, "无法打开文件"), "error");
    } finally {
      setBusyPath(null);
    }
  }, [busyPath, toast]);

  const openFolder = useCallback(async (p: string) => {
    if (busyPath) return;
    setBusyPath(p);
    try {
      await invoke("open_file_location", { path: p });
    } catch (e) {
      toast(errText(e, "无法打开文件夹"), "error");
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
      let opened = 0;
      for (const p of existing) {
        const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        const dir = idx >= 0 ? p.slice(0, idx) : p;
        if (dirs.has(dir)) {
          dirs.delete(dir);
          await invoke("open_file_location", { path: p });
          opened++;
        }
      }
      toast(`已打开 ${opened} 个文件夹`, "success");
    } catch (e) {
      toast(errText(e, "无法打开文件夹"), "error");
    }
  }, [paths, infoMap, toast]);

  return (
    <div className="fd-body" style={{ gap: 12 }}>
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
        maxHeight: 240, overflowY: "auto", paddingRight: 2,
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
                <RowIconBtn title="打开文件" disabled={!exists || busy} onClick={(e) => { e.stopPropagation(); openFile(p); }}>
                  {busy ? <Loader size={13} className="spin" /> : <ExternalLink size={13} />}
                </RowIconBtn>
                <RowIconBtn title="打开文件夹" disabled={!exists || busy} onClick={(e) => { e.stopPropagation(); openFolder(p); }}>
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
          disabled={!loaded || okCount === 0}
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
