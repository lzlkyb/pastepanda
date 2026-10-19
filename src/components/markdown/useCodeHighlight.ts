import { useEffect, type RefObject } from "react";
import { unwrapCodeLines, wrapCodeLines } from "@/lib/markdown/renderHtml";

/**
 * 代码块语法高亮（hljs 异步加载，避免阻塞首屏）。
 * 行号模式：高亮前解包旧行结构（行号文本不得混入源码），高亮后按行重新包裹。
 */
export function useCodeHighlight(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
  showLineNumbers: boolean,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blocks = el.querySelectorAll("pre code");
    if (blocks.length === 0) return;
    blocks.forEach((block) => unwrapCodeLines(block as HTMLElement));
    let cancelled = false;
    import("highlight.js/lib/common").then((hljs) => {
      if (cancelled) return;
      blocks.forEach((block) => {
        if ((block as HTMLElement).closest(".md-codeblock-mermaid")) return; // mermaid 源码块不高亮
        hljs.default.highlightElement(block as HTMLElement);
      });
    }).catch(() => { /* hljs 加载失败时保持纯文本 */ })
      .finally(() => {
        if (cancelled || !showLineNumbers) return;
        blocks.forEach((block) => wrapCodeLines(block as HTMLElement));
      });
    return () => { cancelled = true; };
  }, [containerRef, html, showLineNumbers]);
}
