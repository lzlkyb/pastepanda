/**
 * recsel/snap.ts — 录屏框选的窗口吸附纯函数（设计稿二期 §4）。
 *
 * 候选矩形来自后端 `enum_window_rects`（虚拟屏**物理**像素，与截图同源），
 * 这里做两件事：物理 → 覆盖层本地 CSS 的换算，和光标邻域命中。
 * 不含 React、不含 IO，可无环境单测。
 */

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 覆盖层本地矩形（CSS 像素）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 物理虚拟屏坐标 → 覆盖层本地 CSS 坐标（与选区覆盖层同一口径：÷dpr、减原点）。 */
export function toLocalCssRect(r: SnapRect, originX: number, originY: number, dpr: number): Rect {
  const d = dpr > 0 ? dpr : 1;
  return { x: (r.x - originX) / d, y: (r.y - originY) / d, w: r.w / d, h: r.h / d };
}

/**
 * 光标落在哪个候选窗口的 `pad` 邻域内就吸附谁（先到先得，与截图吸附带同语义）。
 * 返回 null = 自由框选。
 */
export function pickSnapCandidate(
  windows: Rect[],
  p: { x: number; y: number },
  pad = 8,
): Rect | null {
  for (const w of windows) {
    if (
      p.x >= w.x - pad &&
      p.x <= w.x + w.w + pad &&
      p.y >= w.y - pad &&
      p.y <= w.y + w.h + pad
    ) {
      return w;
    }
  }
  return null;
}

/** 宽高对齐偶数（编码器 4:2:0 要求）；不足 16px 的维度由调用方拒绝。 */
export function normalizeEven(r: Rect): Rect {
  return { x: r.x, y: r.y, w: Math.max(16, r.w & ~1), h: Math.max(16, r.h & ~1) };
}

/** 点是否在矩形内（确认态「点选区外 = 重画」的判定）。 */
export function inRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
