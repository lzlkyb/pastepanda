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
/** 底部带的静息下边距（贴屏幕底 16px，与 `.shot-toast` 原来的 CSS bottom 同值） */
export const BAND_BOTTOM = 16;
/** 底部带被抬起时与遮挡矩形 / 屏幕顶的间隙 */
export const BAND_LIFT_GAP = 8;

export type PanelSide = "right" | "left" | "inside";

export interface PanelOptions {
  /**
   * 候选挑选方式，默认 `"first"`（右侧优先，第一个「高度够用」的就用它）。
   *
   * `"tallest"`：在候选里挑可用高度最大的。给**内容行数多、滚动即失焦**的
   * AI 动作面板用——它一屏只看得到两三行，右侧被工具栏压到 208px 时，
   * 左侧能给 372px 就是多一行半；而 OCR 抽屉那种短面板更适合稳定在右侧。
   * 同高时仍按「右 → 左 → 内部」的原优先级，不会为了 1px 跳边。
   */
  pick?: "first" | "tallest";
  /** 高度上限比例，默认 `PANEL_MAX_VH` */
  maxVH?: number;
}

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
 * 避让：只在**水平投影重叠**时才处理，而且是压缩高度而不是移动位置 ——
 *       移位置会让面板在选区变化时跳来跳去，压高度则始终锤在选区顶部。
 *       注意：工具栏右对齐选区右边缘时两者水平不相交；只有选区比工具栏窄
 *       （工具栏退化为左对齐并向右伸出选区）时才会撞上。
 *
 * @param sel     选区（CSS 像素）
 * @param panelW  面板宽（固定值，抽屉 252）
 * @param vw / vh 视口尺寸
 * @param avoid   要避开的矩形**数组**（标注工具栏 / 属性条 / 底部带，
 *                调用方有什么就传什么，null 项自动跳过）。
 *                原来是单个矩形，于是底部带（回执条 / 取色条 / OCR 胶囊）不在名单里：
 *                审计实测 120 组里有 3 组抽屉尾**整条盖掉**底部带（190~201×80），
 *                另有 3 组工具栏压带。收进数组后两处归零。
 *                AI 动作面板故意只传底部带：它压在工具栏上是经过 12 格实测的取舍
 *                （躲工具栏会让最坏一屏一行都看不见），见 `PanelOptions.pick`。
 * @param opts    挑选策略与高度上限，默认沿用 OCR 抽屉的老行为
 *                （`pick: "first"`、`maxVH: PANEL_MAX_VH`）。
 */
export function layoutSidePanel(
  sel: TbRect,
  panelW: number,
  vw: number,
  vh: number,
  avoid?: (TbRect | null)[],
  gap = PANEL_GAP,
  opts: PanelOptions = {},
): PanelLayout {
  const capRatio = opts.maxVH ?? PANEL_MAX_VH;
  // 垂直位置与侧无关，先算
  const top = clamp(sel.y, gap, Math.max(gap, vh - gap - PANEL_MIN_H));

  /** 某个水平位置上实际可用的高度（已扣掉被避让矩形占的部分、也扣掉比例上限） */
  const roomAt = (l: number): number => {
    let h = Math.min(Math.round(vh * capRatio), vh - gap - top); // 不溢出屏幕底
    for (const r of avoid || []) {
      if (!r) continue;
      const overlapX = !(l + panelW <= r.x || l >= r.x + r.w);
      // 只有水平投影重叠才算撞上；避让物在面板下方，所以面板底部不越过它的顶边
      if (overlapX) h = Math.min(h, r.y - gap - top);
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

  let picked: { left: number; side: PanelSide };
  if (opts.pick === "tallest") {
    // 用**取过上限后**的高度比较：两个候选都超过上限时它们其实一样高，
    // 此时保留原优先级（右→左），不为了「未截断的 600 vs 550」跳边。
    picked = candidates.reduce((best, c) =>
      roomAt(c.left) > roomAt(best.left) ? c : best,
    );
  } else {
    picked = candidates.find((c) => roomAt(c.left) >= PANEL_MIN_H) ?? candidates[0];
  }
  const maxHeight = clamp(roomAt(picked.left), PANEL_MIN_H, Math.round(vh * capRatio));

  return { left: picked.left, top, maxHeight, side: picked.side };
}

/**
 * 底部带（回执条 / 找回条 / 取色条 / OCR 进度胶囊 / 快捷键提示）的位置。
 *
 * 为什么要它：这一排浮层原来各写各的 `bottom`（16 / 64 / 16 / top 16），
 * 「谁让位给谁」靠手写数字维持，加一条就得有人记得改另一条的数字。
 * 现在带子只有一条静息规则（贴屏幕底 16px），**被真的挡住了才整条上抬**，
 * 而且抬不到位就不抬（避免为了躲 4px 把带子甩到屏幕中部）。
 *
 * 迭代而不是单趟：抬到属性条上方之后可能又撞上工具栏，所以要反复看到稳定
 * （最多 rects.length + 1 轮，每轮至少躲掉一个矩形）。
 *
 * @param bandW / bandH 带子的实测尺寸
 * @param rects         同屏其他浮层的矩形（工具栏 / 属性条 / 侧边面板），null 跳过
 */
export function layoutBand(
  vw: number,
  vh: number,
  bandW: number,
  bandH: number,
  rects: (TbRect | null)[],
): { left: number; bottom: number } {
  const left = Math.round((vw - bandW) / 2);
  let bottom = BAND_BOTTOM;
  for (let pass = 0; pass <= rects.length; pass++) {
    const top = vh - bottom - bandH;
    let moved = false;
    for (const r of rects) {
      if (!r) continue;
      if (left + bandW <= r.x || left >= r.x + r.w) continue; // 水平不相交
      if (top >= r.y + r.h || top + bandH <= r.y) continue; // 垂直不相交
      // 抬到该矩形上缘之上；上限是「带子顶边留 8px」，抬不到位就当没看见
      const want = Math.min(vh - r.y + BAND_LIFT_GAP, vh - BAND_LIFT_GAP - bandH);
      if (want > bottom) {
        bottom = want;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { left, bottom };
}
