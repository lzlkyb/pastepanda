/**
 * HTML 转义 —— 全应用唯一一份。
 *
 * 收口缘由（规则 #11）：这个函数原先有**两份逐字节相同的副本**，
 * 一份在 `components/MarkdownRenderer.tsx`、一份在 `lib/mermaidBlock.ts`。
 * 两份当时是一致的，但转义函数一旦分歧就是个注入面——哪天有人给其中
 * 一份补上 `'` → `&#39;`，另一份不会跟着改，而且没有任何东西会报错。
 *
 * ❗ 它只做**属性 / 文本节点**级别的转义，不是完整的 HTML 消毒。
 *   真正的消毒在 `MarkdownRenderer` 里由 DOMPurify 兜底（渲染前过一遗）。
 *   所以不要拿它去处理来源不可信的整段 HTML。
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
