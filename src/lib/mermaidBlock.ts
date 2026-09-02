/**
 * 纯函数：mermaid 代码块外壳 HTML 生成 + 主题映射。
 * 独立成模块以避免被 MarkdownRenderer 的 DOMPurify/marked 依赖牵连进单测环境。
 */
import { escapeHtml } from "./markdown/html";

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

const MERMAID_EDIT_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M3 3h7v7H3V3zm11 0h7v7h-7V3zM3 14h7v7H3v-7zm11 3h7M14 21h7M17 14v7"/></svg>';

/**
 * mermaid 代码块外壳 HTML（字符串，因 marked renderer 只能返回 HTML 字符串）。
 * - lang === 'mermaid' 时由 code renderer 调用；
 * - 仅 flowchart/graph 子集显示「编辑」按钮（其余类型渲染成图但不提供编辑入口，避免误导）；
 * - 源码转义后存于隐藏的 .md-mermaid-raw，供复制 / 渲染 / 闭环编辑读取。
 */
export function mermaidBlockHtml(text: string): string {
  const canEdit = /^\s*(flowchart|graph)\b/i.test(text);
  return (
    `<div class="md-codeblock md-codeblock-mermaid">` +
    `<div class="md-codehead">` +
    `<span class="md-wdot md-wdot-r"></span>` +
    `<span class="md-wdot md-wdot-y"></span>` +
    `<span class="md-wdot md-wdot-g"></span>` +
    `<span class="md-langtab">mermaid</span>` +
    `<button type="button" class="md-copybtn">${COPY_ICON} 复制</button>` +
    (canEdit ? `<button type="button" class="md-mermaid-edit">${MERMAID_EDIT_ICON} 编辑</button>` : ``) +
    `</div>` +
    `<div class="md-mermaid-body"></div>` +
    `<pre class="md-mermaid-raw" style="display:none"><code class="language-mermaid">${escapeHtml(text)}</code></pre>` +
    `</div>`
  );
}

/** 当前主题（data-theme）→ mermaid 内置主题，保证 6 套主题下流程图配色协调 */
export function mapMermaidTheme(theme: string): "dark" | "forest" | "neutral" | "default" {
  if (theme === "forest") return "forest";
  if (theme === "ocean-dark" || theme === "midnight") return "dark";
  if (theme === "ocean" || theme === "blossom" || theme === "dawn") return "neutral";
  return "neutral";
}
