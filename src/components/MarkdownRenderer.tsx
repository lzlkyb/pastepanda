import { memo, useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import styles from "./MarkdownRenderer.module.css";

// marked 全局配置（只执行一次）
marked.setOptions({
  gfm: true,
  breaks: true,
});

/** 将 Markdown 文本渲染为安全的 HTML 字符串 */
function renderMarkdownHtml(text: string): string {
  try {
    const raw = marked.parse(text) as string;
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ["input"],
      ADD_ATTR: ["type", "checked", "disabled"],
    });
  } catch {
    return "";
  }
}

/**
 * Markdown 渲染组件
 * - 使用 marked 解析 + DOMPurify 防 XSS
 * - highlight.js 对代码块做语法高亮（异步加载后生效）
 * - compact 模式用于 hover 弹窗（限高、小字号）
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  compact = false,
  className,
}: {
  text: string;
  compact?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => renderMarkdownHtml(text), [text]);

  // 代码块语法高亮（hljs 异步加载，避免阻塞首屏）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blocks = el.querySelectorAll("pre code");
    if (blocks.length === 0) return;
    let cancelled = false;
    import("highlight.js/lib/common").then((hljs) => {
      if (cancelled) return;
      blocks.forEach((block) => {
        hljs.default.highlightElement(block as HTMLElement);
      });
    }).catch(() => { /* hljs 加载失败时保持纯文本 */ });
    return () => { cancelled = true; };
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`${styles.md} ${compact ? styles.compact : ""} ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
