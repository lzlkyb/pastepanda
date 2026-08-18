/**
 * OCR 拖选后的浮复制条（"复制 N 字 / 取消"）位置计算。
 *
 * 为什么需要它：旧实现把复制条钉在拖选矩形的**右下角**
 * （`left: drag.x + drag.w; top: drag.y + drag.h`），拖选靠近屏幕右缘/下缘时
 * 复制条整体溢出视口、点不到 —— 而复制是这个功能唯一的产出动作，点不到等于废。
 *
 * 与 layoutSizeLabel / layoutSidePanel 同一套做法：位置由纯函数算、配单测，
 * CSS 只管长相不管位置。本函数做**四象限翻转**：
 *   右下（默认）→ 左下 → 右上 → 左上，全部放不下才钳进视口兜底。
 * 坐标全部是 **CSS 像素**（调用方先把物理像素的拖选矩形 css() 换算好再传）。
 *
 * 为什么宽高用固定常量而不是 DOM 实测：sizeLabel 的 SIZE_LABEL_H 也是固定常量，
 * 复制条两个按钮横排，固定宽度不会随内容伸缩（"复制 N 字"N 最大三位数），
 * 常量让判定精确、可单测，也避免 ref 测量带来的首帧跳动。
 */

import type { TbRect } from "./toolbarPos";

/** 复制条宽（CSS 像素，与 .ocr-copy-bar 的 width 一致；"复制 999 字"+"取消"横排够用） */
export const OCR_BAR_W = 168;
/** 复制条高（CSS 像素，与 .ocr-copy-bar 的 height 一致） */
export const OCR_BAR_H = 34;
/** 复制条与拖选矩形的间距 */
export const OCR_BAR_GAP = 6;

export type OcrBarPlace = "br" | "bl" | "tr" | "tl" | "fit";

export interface OcrBarLayout {
  left: number;
  top: number;
  place: OcrBarPlace;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 算浮复制条的位置。
 *
 * 候选顺序：右下 → 左下 → 右上 → 左上（先水平翻再垂直翻，读起来最自然）。
 * 四个象限都放不下（拖选矩形几乎占满屏幕）时钳进视口内，保证至少可点。
 *
 * @param drag 拖选矩形（CSS 像素）
 * @param vw / vh 视口尺寸（CSS 像素，window.innerWidth/innerHeight）
 * @param gap 与矩形的间距，默认 OCR_BAR_GAP
 */
export function layoutOcrCopyBar(drag: TbRect, vw: number, vh: number, gap = OCR_BAR_GAP): OcrBarLayout {
  const candidates: { left: number; top: number; place: OcrBarPlace }[] = [
    { left: drag.x + drag.w + gap, top: drag.y + drag.h + gap, place: "br" },
    { left: drag.x - OCR_BAR_W - gap, top: drag.y + drag.h + gap, place: "bl" },
    { left: drag.x + drag.w + gap, top: drag.y - OCR_BAR_H - gap, place: "tr" },
    { left: drag.x - OCR_BAR_W - gap, top: drag.y - OCR_BAR_H - gap, place: "tl" },
  ];
  for (const c of candidates) {
    if (c.left >= 0 && c.left + OCR_BAR_W <= vw && c.top >= 0 && c.top + OCR_BAR_H <= vh) return c;
  }
  // 兜底：钳进视口（宁可压住矩形一角，也不能让它点不到）
  return {
    left: clamp(drag.x + drag.w + gap, 0, Math.max(0, vw - OCR_BAR_W)),
    top: clamp(drag.y + drag.h + gap, 0, Math.max(0, vh - OCR_BAR_H)),
    place: "fit",
  };
}
