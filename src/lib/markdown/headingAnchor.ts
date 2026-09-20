/**
 * Markdown 标题 id / 锚点 —— 给 MarkdownRenderer 用的纯 HTML 生成（规则 #11）。
 *
 * 与大纲 `scanHeadings` 共用 `headingSlug` 分配器，保证预览 heading id
 * 与大纲点击时查找的 slug 一致。DOMPurify 默认放行 `id` 与 `href="#…"`。
 */
import { createSlugAllocator, queryByHeadingId } from "./headingSlug";
import { escapeHtml } from "./html";

let alloc: ((text: string) => string) | null = null;

/** 每次 renderMarkdownHtml 开头调用：slug 计数从零开始 */
export function resetHeadingSlugState(): void {
  alloc = createSlugAllocator();
}

/** 从标题纯文本取下一个唯一 slug */
export function nextHeadingSlug(plainText: string): string {
  if (!alloc) alloc = createSlugAllocator();
  return alloc(plainText);
}

/**
 * 组装 heading HTML。
 * @param inner 已解析的行内 HTML
 * @param plain 用于 slug 的纯文本（去掉 md 标记）
 */
export function headingHtml(depth: number, inner: string, plain: string): string {
  const d = Math.min(6, Math.max(1, depth));
  const slug = nextHeadingSlug(plain);
  const idAttr = escapeHtml(slug);
  const href = `#${idAttr}`;
  // 真锚点：hover「#」可点（L6）；点击由 MarkdownRenderer 委托拦截，
  // 在预览容器内滚动，避免原生 hash 滚到 window。
  return (
    `<h${d} id="${idAttr}" data-md-heading="1">` +
    `${inner}` +
    `<a class="md-hanchor" href="${href}" title="复制此标题链接" aria-label="标题锚点">#</a>` +
    `</h${d}>\n`
  );
}

/**
 * 目标标题/节点的跳转反馈高亮（大纲跳转与正文锚点共用，规则 #11）。
 * 入场 300ms（md-hit：位移 + 底色扫入），随后保持 md-flash 语义约 900ms 淡出。
 * reduced-motion 由 globals.css 全局兜底，此处不写第二套。
 */
export function flashHeadingTarget(el: Element): void {
  el.classList.remove("md-hit", "md-flash");
  // 强制 reflow：连续点同一目标时保证动画能重播
  void (el as HTMLElement).offsetWidth;
  el.classList.add("md-hit", "md-flash");
  window.setTimeout(() => el.classList.remove("md-hit", "md-flash"), 900);
}

/**
 * 拦截预览内的 `a[href^="#"]`：容器内定位 + 闪烁。
 * @returns "ok" | "miss" | "ignore"
 */
export function handleAnchorClick(
  container: HTMLElement,
  anchor: HTMLAnchorElement,
): "ok" | "miss" | "ignore" {
  const raw = anchor.getAttribute("href") || "";
  if (!raw || raw === "#") return "ignore";
  const id = decodeURIComponent(raw.replace(/^#/, ""));
  if (!id) return "ignore";

  const target = queryByHeadingId(container, id);
  if (!target) {
    showAnchorMiss(container, id);
    return "miss";
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  flashHeadingTarget(target);
  return "ok";
}

/** 锚点失效提示：挂在预览容器顶部，与触发同一可见性域（规则 15 / U3） */
function showAnchorMiss(container: HTMLElement, id: string) {
  let tip = container.querySelector<HTMLElement>(":scope > .md-anchor-miss");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "md-anchor-miss";
    container.insertBefore(tip, container.firstChild);
  }
  tip.textContent = `未找到对应标题：#${id}`;
  tip.classList.add("show");
  window.setTimeout(() => tip.classList.remove("show"), 2400);
}
