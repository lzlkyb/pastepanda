/** 会话画面 canvas 的布局 style（fit/actual/fill）+ 本地光标定位。 */
import type { FitMode } from "@/lib/rcSessionStats";

const FIT_CSS: Record<FitMode, "contain" | "none" | "cover"> = {
  fit: "contain",
  actual: "none",
  fill: "cover",
};

export function canvasStyleFor(
  fit: FitMode,
  size: { w: number; h: number },
  canControl: boolean,
): React.CSSProperties {
  const cursor = canControl ? "crosshair" : "default";
  if (fit === "actual") {
    return {
      width: size.w || undefined,
      height: size.h || undefined,
      maxWidth: "none",
      maxHeight: "none",
      imageRendering: "pixelated",
      cursor,
    };
  }
  return { width: "100%", height: "100%", objectFit: FIT_CSS[fit], cursor };
}

/**
 * B1：本地光标 overlay 的定位 style（相对包裹 canvas 的 wrapper）。
 *
 * 与 `mapNormFromCanvas` 同一套几何（contain/cover 的居中裁切），
 * 方向反过来：内容坐标 0..1 → 元素内像素。渲染期现算（光标 state
 * 变更触发 re-render），窗口 resize 后下一次移动鼠标即自校正。
 */
export function cursorOverlayStyle(
  cursor: { u: number; v: number },
  el: HTMLCanvasElement | null,
  contentW: number,
  contentH: number,
  fit: FitMode,
): React.CSSProperties | undefined {
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  const nw = contentW || el.width || 1;
  const nh = contentH || el.height || 1;
  const scale =
    fit === "fill"
      ? Math.max(rect.width / nw, rect.height / nh)
      : Math.min(rect.width / nw, rect.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  return {
    left: (rect.width - dw) / 2 + cursor.u * dw,
    top: (rect.height - dh) / 2 + cursor.v * dh,
  };
}
