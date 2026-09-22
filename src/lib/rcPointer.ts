/**
 * 远程画面指针几何——canvas 坐标 ↔ 远程内容归一化坐标。
 *
 * 从 `hooks/useRcInput.ts` 拆出（2026-09-22，.ts ≤ 400 红线）：这里是纯几何，
 * 不碰 React、不碰 invoke，可独立单测（用例在 `useRcInput.test.ts`，
 * 经 re-export 保持原 import 路径不变）。
 */

/** B1：本地光标的内容坐标（0..1，相对远程画面）。 */
export interface RcCursorPos {
  u: number;
  v: number;
}

/** 与 `rcCanvasStyle.ts` 同一套几何（contain/cover 的居中裁切）。 */
export function mapNormFromCanvas(
  e: { clientX: number; clientY: number },
  el: HTMLCanvasElement,
  contentW: number,
  contentH: number,
  fit: "fit" | "actual" | "fill" = "fit",
) {
  const rect = el.getBoundingClientRect();
  const nw = contentW || el.width || 1;
  const nh = contentH || el.height || 1;
  // contain 用 min（letterbox），cover/fill 用 max（溢出裁切）
  const scale =
    fit === "fill"
      ? Math.max(rect.width / nw, rect.height / nh)
      : Math.min(rect.width / nw, rect.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = rect.left + (rect.width - dw) / 2;
  const oy = rect.top + (rect.height - dh) / 2;
  const u = (e.clientX - ox) / dw;
  const v = (e.clientY - oy) / dh;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return {
    x: Math.round(clamp01(u) * 65535),
    y: Math.round(clamp01(v) * 65535),
  };
}
