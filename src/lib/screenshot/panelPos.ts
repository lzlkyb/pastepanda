/**
 * 侧边面板（OCR 胶囊 / OCR 抽屉）的位置计算。
 *
 * 为什么需要它：旧实现把两者都钉在 `right: 14px; top: 14px`（屏幕右上角），
 * 与选区毫无关系。后果有两个：
 *   ① 选区在左下角时，胶囊蹦到右上角，视线要跨整个屏幕（违反规则 17.2）；
 *   ② 选区在右上角时，252px 宽的抽屉直接压在选区上，挡住要看的内容。
 * 这与工具栏之前的 `left: 50%` 是同一类病，解法也同源（参见 toolbarPos.ts）。
 *
 * 坐标全部是 **CSS 像素**。
 */

import type { TbRect } from "./toolbarPos";

/** 面板与选区 / 屏幕边缘的间距 */
export const PANEL_GAP = 8;
/** 面板最小可用高度：再矮就什么都看不下了，宁可让它盖住工具栏 */
export const PANEL_MIN_H = 120;
/** 面板高度上限（占视口比例），与旧 CSS 的 max-height: 62vh 一致 */
export const PANEL_MAX_VH = 0.62;

export type PanelSide = "right" | "left" | "inside";

export interface PanelLayout {
  left: number;
  top: number;
  /** 面板的高度上限（写进 style.maxHeight）。
   *  用上限而不是固定高度，是因为抽屉真实高度取决于 OCR 行数，
   *  提前算不出来；交给 CSS 自适应，我们只负责不让它溢出屏幕 / 不压工具栏。 */
  maxHeight: number;
  side: PanelSide;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 算侧边面板的位置。
 *
 * 水平：选区**右外侧**优先（图在左、文字在右，符合阅读习惯）；
 *       右侧放不下退左侧；两侧都放不下（选区很宽）则贴选区内部右侧。
 * 垂直：顶部对齐选区顶部，再钳回视口内。
 * 避让工具栏：只在**水平投影重叠**时才处理，而且是压缩高度而不是移动位置 ——
 *       移位置会让面板在选区变化时跳来跳去，压高度则始终锤在选区顶部。
 *       注意：工具栏右对齐选区右边缘时两者水平不相交；只有选区比工具栏窄
 *       （工具栏退化为左对齐并向右伸出选区）时才会撞上。
 *
 * @param sel     选区（CSS 像素）
 * @param panelW  面板宽（固定值，抽屉 252）
 * @param vw / vh 视口尺寸
 * @param avoid   要避开的矩形（标注工具栏），不需要时传 null
 */
export function layoutSidePanel(
  sel: TbRect,
  panelW: number,
  vw: number,
  vh: number,
  avoid?: TbRect | null,
  gap = PANEL_GAP,
): PanelLayout {
  // 垂直位置与侧无关，先算
  const top = clamp(sel.y, gap, Math.max(gap, vh - gap - PANEL_MIN_H));

  /** 某个水平位置上实际可用的高度（已扣掉被工具栏占的部分） */
  const roomAt = (l: number): number => {
    let h = vh - gap - top; // 不溢出屏幕底
    if (avoid) {
      const overlapX = !(l + panelW <= avoid.x || l >= avoid.x + avoid.w);
      // 只有水平投影重叠才算撞上；工具栏在下方，所以面板底部不越过它的顶边
      if (overlapX) h = Math.min(h, avoid.y - gap - top);
    }
    return h;
  };

  // ---- 水平：按优先级凑候选，选第一个"高度够用"的 ----
  // 为什么不是先定侧再压高度：窄矮选区下，右侧可用高度 = 选区高度（工具栏就在选区下方 8px），
  // 压完根本不够显示。而换到左侧往往恰好避开工具栏（工具栏向右伸），能拿到完整高度。
  const candidates: { left: number; side: PanelSide }[] = [];
  const rightSide = sel.x + sel.w + gap;
  const leftSide = sel.x - gap - panelW;
  if (rightSide + panelW <= vw - gap) candidates.push({ left: rightSide, side: "right" });
  if (leftSide >= gap) candidates.push({ left: leftSide, side: "left" });
  // 兜底：两侧都放不下（选区很宽）就贴选区内部右侧，半透明由 CSS 处理
  candidates.push({
    left: clamp(sel.x + sel.w - panelW - gap, gap, Math.max(gap, vw - gap - panelW)),
    side: "inside",
  });

  const picked =
    candidates.find((c) => roomAt(c.left) >= PANEL_MIN_H) ?? candidates[0];
  const maxHeight = clamp(
    roomAt(picked.left),
    PANEL_MIN_H, // 所有候选都不够时：宁可盖住工具栏也要能用
    Math.round(vh * PANEL_MAX_VH),
  );

  return { left: picked.left, top, maxHeight, side: picked.side };
}
