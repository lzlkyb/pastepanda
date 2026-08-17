/**
 * 遮罩类标注（马赛克 / 模糊 / 高亮）的几何：笔刷宽度、包围盒、与 OCR 行的遮挡判定。
 *
 * 单独成文件而不是塞进 draw.ts 或 geometry.ts：这三件事 draw.ts（绘制）、
 * geometry.ts（命中检测）、ScreenshotOverlay（OCR 行框渲染）都要用，
 * 写在任意一处都会变成另外两处的私有依赖。全是纯函数，带单测。
 */

import type { Annotation } from "./types";

/** 矩形（选区本地物理坐标，与标注同坐标系） */
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 遮罩笔刷宽度相对线宽档位的倍数。
 *
 * 为什么要放大：WIDTHS 是 2/3/5 **物理**像素，那个档位是给矩形 / 箭头描边定的。
 * 直接当遮罩笔刷用就太细了 —— 125% 缩放屏上 3 物理像素只有 2.4 CSS 像素，
 * 想涂掉一行字得来回抹十几遍（实测反馈：「马赛克笔画太小」）。
 *
 * 8 倍 → 16 / 24 / 40 物理像素（≈ 13 / 19 / 32 CSS 像素），一笔盖住一行文字。
 * 高亮原本自己写了个 ×4，现在马赛克 / 模糊 / 高亮三家统一走这里（规则 11 收口）。
 */
export const MASK_BRUSH_SCALE = 8;

/**
 * 遮罩笔刷的实际描边宽度（物理像素）。
 *
 * ❗ maskBox 的扩边与实际描遮罩**必须用同一个值**，否则笔刷会被自己的包围盒
 * 裁掉一圈（离屏层只有包围盒那么大）。这也是把它抽成函数的唯一理由。
 */
export function maskBrushWidth(a: Annotation): number {
  return Math.max(12, a.width * MASK_BRUSH_SCALE);
}

/**
 * 遮罩类标注的包围盒（底图坐标需再加 offX/offY）。
 *
 * brush 形态下取路径包围盒并向外扩半个**笔刷**宽度（笔头是圆的，不扩就会裁到）；
 * rect 形态下就是拖出来的矩形。
 */
export function maskBox(a: Annotation): MaskRect {
  if (a.shape === "brush" && a.points && a.points.length > 0) {
    const bw = maskBrushWidth(a);
    const r = bw / 2;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const [px, py] of a.points) {
      if (px < x1) x1 = px;
      if (py < y1) y1 = py;
      if (px > x2) x2 = px;
      if (py > y2) y2 = py;
    }
    return { x: x1 - r, y: y1 - r, w: x2 - x1 + bw, h: y2 - y1 + bw };
  }
  const x = Math.min(a.x, a.x2);
  const y = Math.min(a.y, a.y2);
  return { x, y, w: Math.abs(a.x2 - a.x), h: Math.abs(a.y2 - a.y) };
}

/**
 * 算「遮蔽」的只有马赛克与模糊。
 *
 * 高亮**不算**：荧光笔是为了让那行字更醒目，盖上去以后文字照样可读
 * （见 draw.ts 里 multiply 的说明），把它当遮蔽会把高亮过的行也变成不可点。
 */
function isOpaqueMask(a: Annotation): boolean {
  return a.type === "mosaic" || a.type === "blur";
}

/** 两矩形是否有重叠面积（共边不算） */
function rectsOverlap(a: MaskRect, b: MaskRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 线段是否与矩形相交（Liang-Barsky 参数裁剪）。
 *
 * 为什么需要它：只判「采样点是否落在矩形里」会漏掉快速拖动 ——
 * mousemove 一次可以跨几十像素，两个采样点都在行框外、连线却横穿整行。
 * 那种情况下文字确实被涂掉了，行框却仍然可点。
 */
function segIntersectsRect(
  p1: [number, number],
  p2: [number, number],
  r: MaskRect,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  /** 处理一条边界：约束形如 p·t <= q */
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // 与该边平行：只要在带内就继续判下一条
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, p1[0] - r.x) &&
    clip(dx, r.x + r.w - p1[0]) &&
    clip(-dy, p1[1] - r.y) &&
    clip(dy, r.y + r.h - p1[1])
  );
}

/**
 * OCR 行是否被遮罩盖住（纯函数，带单测）。
 *
 * 用处：被马赛克 / 模糊盖住的 OCR 行框**不能再渲染、更不能可点**。
 * 不做这个判定的后果不只是「点一下冒出个绿色的已复制标签」——
 * 行框点一下复制的是**整行原文**，于是用户打了码的密码 / 手机号
 * 在结果态点一下就进剪贴板了，遮罩等于没生效。
 *
 * 阈值定成「有任何交集就算被遮」而不是「盖过一半」：复制的粒度是整行，
 * 只要行内有一小段被盖住（比如行尾的手机号），复制整行照样把它泄出去。
 * 遮罩的语义是「这块我不想给出去」，宁可多屏蔽一行，不能漏一行。
 */
export function isRowMasked(row: MaskRect, annots: Annotation[]): boolean {
  for (const a of annots) {
    if (!isOpaqueMask(a)) continue;
    if (a.shape === "brush" && a.points && a.points.length > 0) {
      // 笔刷是圆头粗线：把行框向外膨胀半个笔宽，再判采样点落入 / 线段穿过。
      const r = maskBrushWidth(a) / 2;
      const infl: MaskRect = {
        x: row.x - r,
        y: row.y - r,
        w: row.w + r * 2,
        h: row.h + r * 2,
      };
      for (const [px, py] of a.points) {
        if (px >= infl.x && px <= infl.x + infl.w && py >= infl.y && py <= infl.y + infl.h) {
          return true;
        }
      }
      for (let i = 1; i < a.points.length; i++) {
        if (segIntersectsRect(a.points[i - 1], a.points[i], infl)) return true;
      }
    } else if (rectsOverlap(maskBox(a), row)) {
      return true;
    }
  }
  return false;
}
