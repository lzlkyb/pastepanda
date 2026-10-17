/**
 * RecTargetFrames — 选区视觉层（规则 7：从 RecOverlayParts 再拆一层）。
 *
 * 暗遮罩 + 全屏四边暗带 + 选区框 / 悬停高亮 / 拖拽吸附；只按 phase 决定「谁在框里」。
 * 纯展示：几何全部由调用方给，不含状态与 IO。
 *
 * 框的语义分两级（2026-10-16 设计稿 §1，避免「预览框」与「已采纳框」都是同一条实线）：
 * `.rec-rect`（已落子）= 实线；`.rec-snap`（悬停候选，还没定）= 虚线 + 四角 crop mark。
 * 两者同用 accent——一屏只有一个强调色，靠线型而不是颜色区分。
 */
import type { Phase } from "@/hooks/useRecSelectMouse";
import type { Rect } from "./snap";

/** 四块暗遮罩（框外区域；坐标与截图同法）。 */
function Shades({ rect, screenCss }: { rect: Rect; screenCss: { w: number; h: number } }) {
  const top = { left: 0, top: 0, width: screenCss.w, height: Math.max(0, rect.y) };
  const bottom = {
    left: 0,
    top: rect.y + rect.h,
    width: screenCss.w,
    height: Math.max(0, screenCss.h - rect.y - rect.h),
  };
  const left = { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h };
  const right = {
    left: rect.x + rect.w,
    top: rect.y,
    width: Math.max(0, screenCss.w - rect.x - rect.w),
    height: rect.h,
  };
  return (
    <>
      {[top, bottom, left, right].map((s, i) => (
        <div
          key={i}
          className="rec-shade"
          style={{ left: s.left, top: s.top, width: s.width, height: s.height }} /* ui-rule-ok: 四块遮罩跟随选区矩形，几何值是运行时算的 */
        />
      ))}
    </>
  );
}

export function TargetFrames({
  phase,
  recording,
  rect,
  hoverRect,
  snapRect,
  screenCss,
}: {
  phase: Phase;
  recording: boolean;
  rect: Rect;
  hoverRect: Rect | null;
  snapRect: Rect | null;
  screenCss: { w: number; h: number };
}) {
  // The independent compact control owns recording feedback; leave no animated fullscreen surface.
  if (recording) return null;
  const hovering = phase === "preview" && hoverRect !== null;
  // 悬停高亮（预览态）与拖拽吸附（拖拽态）互斥，共用同一枚 .rec-snap
  const highlight = hovering ? hoverRect : phase === "dragging" ? snapRect : null;
  return (
    <>
      {/* 暗遮罩：预览/拖拽/确认态才有；录制中零遮挡（预览态 rect=整屏 ⇒ 四块零面积 = 不压暗） */}
      {!recording && <Shades rect={rect} screenCss={screenCss} />}
      {/* 全屏预览态的四边暗带（同截图 .edge-band 的全屏辨识；几何是常量，收进 CSS） */}
      {phase === "preview" && (
        <>
          <div className="rec-edge-band eb-t" />
          <div className="rec-edge-band eb-b" />
          <div className="rec-edge-band eb-l" />
          <div className="rec-edge-band eb-r" />
        </>
      )}
      {/* 选区框：悬停/吸附高亮亮起时整屏框让位（两个框并存会打架，L5 不靠猜） */}
      {!hovering && (
        <div
          className={`rec-rect${phase === "preview" ? " full" : ""}${recording ? " recording" : ""}`}
          style={{ left: rect.x - 1.5, top: rect.y - 1.5, width: rect.w, height: rect.h }} /* ui-rule-ok: 动态定位（跟随选区），同文件既有模式 */
        />
      )}
      {highlight && (
        <div
          className="rec-snap"
          style={{ left: highlight.x - 1.5, top: highlight.y - 1.5, width: highlight.w, height: highlight.h }} /* ui-rule-ok: 动态定位（跟随候选窗口），同文件既有模式 */
        />
      )}
    </>
  );
}
