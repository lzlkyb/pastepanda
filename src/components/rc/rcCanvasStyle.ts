/** 会话画面 canvas 的布局 style（fit/actual/fill）。 */
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
