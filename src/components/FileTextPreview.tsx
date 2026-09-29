/**
 * FileTextPreview — 文件详情弹框的文本预览主体（语法高亮 + 行号 + 面板内搜索）。
 *
 * 从 FilePreviewPanel.tsx 提出（拆件守规则 #7 的 300 行红线）。搜索命中高亮、
 * Ctrl/Cmd+F、复制全文、编辑器打开都收在这一层，调用方只喂 `data` + `path`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, ExternalLink, Search } from "lucide-react";
import { useToast } from "@/components/Toast";
import { highlightCode } from "@/lib/utils";
import { openInEditor } from "@/lib/openInEditor";
import { readTextFull } from "@/lib/fileActions";
import { textContentType, type TextPreviewData } from "@/lib/fileDetail";

/** 文本预览主体：语法高亮 + 行号 + 面板内搜索 + 复制全文 + 编辑器打开 */
export function TextPreviewBody({ data, path }: { data: TextPreviewData; path: string }) {
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
      const full = await readTextFull(path);
      await navigator.clipboard.writeText(full);
      toast("已复制全文", "success");
    } catch { toast("复制失败", "error"); }
  }, [path, toast]);

  const openInFullscreen = useCallback(() => {
    openInEditor({ filePath: path, contentType: textContentType(data.extension) }).catch(() => {});
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
        <button className="fpt-btn" onClick={openInFullscreen} title="在编辑器中打开"><ExternalLink size={12} /> 编辑器打开</button>
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
