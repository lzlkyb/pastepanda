/**
 * tooltip 悬浮提示的定位纯计算（与绘制/坐标换算同列 lib/screenshot/，便于回归测试）。
 *
 * 背景：原实现用 `.tool:hover::after` 伪元素，但它被困在 `.annot-toolbar`(z-index:30)
 * 的层叠上下文里，而 `.attr-bar`(z-index:31) 是同级独立层 —— 31 > 30，于是工具栏内
 * 所有 ::after tooltip 都被属性条压住（尤其工具栏落在选区下方、tooltip 向下弹时）。
 * 改走 React Portal 浮层（TooltipLayer.tsx）后，tooltip 不再受任何层叠上下文约束，
 * 这里只负责"上弹还是下弹"的纯几何决策，可单测。
 */

export interface TipRect {
  top: number;
  bottom: number;
}

/**
 * 根据元素包围盒与视口高度决定 tooltip 在上还是下。
 * @returns below=true 表示 tooltip 显示在元素**下方**（top 贴合元素底边），false 表示上方。
 *
 * 规则（单一翻转，根治两个历史 bug）：
 * - **默认上弹**：tooltip 出现在元素上方。上方是屏幕顶边/空白区，远离选区画布与下方属性条——
 *   无论工具栏在选区下方（select 默认态，上方是选区图像）还是选区上方（top-attached 态，
 *   上方是屏幕空白），上弹都不压住用户正在标注的画布。这是"上弹不压画布"的关键。
 * - **仅贴顶下弹**：当元素贴着屏幕顶边、上方放不下（rect.top - estH - gap < 0）时才下弹；
 *   此时下方通常有空间，且 Portal 浮层 z-index:950 在最上层，不会被属性条/画布遮挡。
 *
 * 早期版本写成"下半屏优先下弹"，结果工具栏在选区上方（top-attached，rect.top 落屏幕中下部）
 * 时被判成下弹、tooltip 直接盖住画布 —— 这是被报的回归点，已修正为"永远优先上弹"。
 *
 * @param estH tooltip 预估高度（含 padding/字号），默认 30；gap 与元素间距，默认 8（对齐原 ::after 的 top:calc(100%+8px)）。
 */
export function tipPlacement(rect: TipRect, vh: number, estH = 30, gap = 8): boolean {
  // 优先上弹；仅当元素贴顶、上方放不下时才下弹
  return rect.top - estH - gap < 0;
}
