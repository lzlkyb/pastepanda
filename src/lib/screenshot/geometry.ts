/**
 * 截图的几何纯函数：坐标系换算、磁吸对齐、标注命中检测。
 *
 * 从 ScreenshotOverlay 抽出来的原因：这几个函数里藏过两个真 bug（坐标没减 origin、
 * 磁吸把 x/y 候选混在一起），而它们全是无副作用的纯计算——放在 3000 行的组件里
 * 既测不了也看不见。抽出来后可以直接写回归测试（规则 7：纯计算抽到 lib/）。
 */

import type { Annotation, Rect, ScreenInfo, SnapRect } from "./types";

/* ===== 坐标系换算（多显示器必需） =====
 * 底图 / 选区 / Canvas 用的是「底图局部坐标」，原点在虚拟屏幕左上角；
 * 后端的 snap_window_at / get_cursor_pos / send_mouse_wheel 用的是「屏幕坐标」。
 * 两者差一个 (originX, originY)。主显示器在最左上时 origin=(0,0)，两者恰好相等——
 * 这就是原来漏掉换算却看不出问题的原因；副屏摆在主屏左边/上边时
 * SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN 为负，不换算就会整体偏移。
 * ⚠️ 新增任何跟后端交换坐标的调用，必须走这两个函数，不要裸算（规则 11.1）。 */

/** 底图局部坐标 → 屏幕坐标 */
export function toScreenPt(s: ScreenInfo | null, x: number, y: number): [number, number] {
  return [x + (s?.originX ?? 0), y + (s?.originY ?? 0)];
}

/** 屏幕坐标矩形 → 底图局部坐标矩形 */
export function toLocalRect(s: ScreenInfo | null, r: SnapRect): Rect {
  return { x: r.x - (s?.originX ?? 0), y: r.y - (s?.originY ?? 0), w: r.w, h: r.h };
}

/** 磁吸阈值（物理像素） */
export const MAGNET_T = 8;

/**
 * 磁吸：选区边缘贴近 屏幕边 / 中心线 / 参照窗口边缘（≤ 8px）时吸附对齐。
 *
 * ⚠️ 水平候选只能用参照矩形的 x 边，垂直候选只能用 y 边。
 * 原实现把 [x, x+w, y, y+h] 一股脑塞进四个数组，于是选区左边缘会吸到窗口的 top 值、
 * 上边缘会吸到窗口的 left 值——表现就是拖选时选区莫名跳一下。
 */
export function applyMagnet(r: Rect, refs: Rect[], sw: number, sh: number): Rect {
  const T = MAGNET_T;
  const midX = sw / 2;
  const midY = sh / 2;
  const xEdges = refs.flatMap((b) => [b.x, b.x + b.w]);
  const yEdges = refs.flatMap((b) => [b.y, b.y + b.h]);
  const lefts = [0, midX, ...xEdges];
  const rights = [sw, midX, ...xEdges];
  const tops = [0, midY, ...yEdges];
  const bottoms = [sh, midY, ...yEdges];
  let x = r.x;
  let y = r.y;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  for (const c of lefts)
    if (Math.abs(x - c) <= T) {
      x = c;
      break;
    }
  for (const c of rights)
    if (Math.abs(x2 - c) <= T) {
      x2 = c;
      break;
    }
  for (const c of tops)
    if (Math.abs(y - c) <= T) {
      y = c;
      break;
    }
  for (const c of bottoms)
    if (Math.abs(y2 - c) <= T) {
      y2 = c;
      break;
    }
  return { x, y, w: Math.max(4, x2 - x), h: Math.max(4, y2 - y) };
}

/** 点到线段距离（箭头命中检测） */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 点是否命中标注元素（选中 / 橡皮擦共用；eraser 永不命中） */
export function pointHitAnnot(px: number, py: number, a: Annotation): boolean {
  const x = Math.min(a.x, a.x2);
  const y = Math.min(a.y, a.y2);
  const w = Math.abs(a.x2 - a.x);
  const h = Math.abs(a.y2 - a.y);
  const pad = Math.max(8, a.width);
  switch (a.type) {
    case "rect":
    case "highlight":
    case "mosaic":
    case "blur":
    case "text": {
      return px >= x - pad && px <= x + w + pad && py >= y - pad && py <= y + h + pad;
    }
    case "ellipse": {
      if (w <= 0 || h <= 0) return false;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const dx = (px - cx) / (w / 2 + pad);
      const dy = (py - cy) / (h / 2 + pad);
      return dx * dx + dy * dy <= 1;
    }
    case "arrow": {
      return distToSegment(px, py, a.x, a.y, a.x2, a.y2) < Math.max(8, a.width * 2);
    }
    case "pen": {
      if (!a.points) return false;
      const t = Math.max(8, a.width + 3);
      for (const [ax, ay] of a.points) {
        if (Math.abs(px - ax) <= t && Math.abs(py - ay) <= t) return true;
      }
      return false;
    }
    case "number": {
      const r = (a.size ?? 18) / 2 + 4;
      const cx = a.x + r;
      const cy = a.y + r;
      return Math.hypot(px - cx, py - cy) <= r;
    }
    default:
      return false;
  }
}

/** 橡皮擦：擦除路径经过的所有标注元素 id */
export function eraseHits(points: [number, number][], annots: Annotation[]): number[] {
  const hit = new Set<number>();
  for (const [px, py] of points) {
    for (const a of annots) {
      if (a.type === "eraser") continue;
      if (pointHitAnnot(px, py, a)) hit.add(a.id);
    }
  }
  return [...hit];
}
