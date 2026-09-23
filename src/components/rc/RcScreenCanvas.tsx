/**
 * RcScreenCanvas — 会话画面区：canvas + B1 本地光标 overlay + 滚轮转发。
 * （从 RcSessionView 拆出，2026-09-18，.tsx ≤ 300 红线。）
 *
 * 🔴 wrapper 必须包住 canvas 且 position:relative：光标坐标按 canvas
 * 内容几何（contain/cover 居中裁切）换算，overlay 与 canvas 同域才能对得上。
 */
import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { FitMode } from "@/lib/rcSessionStats";
import type { RcCursorShape } from "@/hooks/useRcCursor";
import { cursorCssFor } from "@/hooks/useRcCursor";
import { canvasStyleFor, cursorOverlayStyle } from "./rcCanvasStyle";
import type { useRcInput } from "@/hooks/useRcInput";
import styles from "./RemoteComputer.module.css";

type RcInput = ReturnType<typeof useRcInput>;

export function RcScreenCanvas({
  canvasRef,
  contentRef,
  size,
  fit,
  canControl,
  hasFrame,
  active,
  input,
  cursorShape,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  contentRef: React.MutableRefObject<{ w: number; h: number }>;
  size: { w: number; h: number };
  fit: FitMode;
  canControl: boolean;
  hasFrame: boolean;
  /** B1：窗口「可见且在前台」（useRcFrames.visible）。画面暂停时指针也要哑——
   *  否则用户只是把鼠标滑过一个失焦窗口，远端光标就跟着动、点一下还打在
   *  一帧已经不更新的旧画面上。 */
  active: boolean;
  input: RcInput;
  /** P1-6：远端光标形状；null = 尚未收到（视为箭头）。 */
  cursorShape?: RcCursorShape | null;
}) {
  const baseStyle = canvasStyleFor(fit, size, canControl);
  // P3-6：canvas 尺寸变化时重算光标 overlay（否则 resize 后偏移到下次鼠标移动才校正）
  const [geomTick, setGeomTick] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGeomTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef]);
  // P1-6：远端换形状（I-beam/缩放柄/隐藏……）→ 用本地系统光标按形状渲染；
  // 箭头（及未收到）→ 维持 B1 overlay。hidden 时 overlay 也要藏。
  const cssCursor = canControl && hasFrame ? cursorCssFor(cursorShape ?? null) : null;
  const shapeIsArrow = cursorShape == null || cursorShape === "arrow" || cursorShape === "unknown";
  const useOverlay = canControl && hasFrame && input.cursor != null && (shapeIsArrow || cssCursor === null);
  const baseCursor =
    canControl && hasFrame && input.cursor && !cssCursor ? ("none" as const) : cssCursor ? cssCursor : baseStyle.cursor;
  const canvasStyle = { ...baseStyle, cursor: baseCursor };
  // geomTick 参与计算：ResizeObserver 触发 re-render 后立刻按新矩形定位
  const cursorPos = input.cursor
    ? cursorOverlayStyle(input.cursor, canvasRef.current, contentRef.current.w, contentRef.current.h, fit)
    : undefined;
  void geomTick;
  // 「画面区整体接管指针」（业界基线，noVNC/Guacamole 同款）：指针事件挂在
  // 最外层容器而不是 canvas 元素上——object-fit 留出的黑边（fit/fill 模式上下
  // 的留白）同样命中处理器，映射时 clamp 到画面边缘，远程最边缘可点。
  // 1:1（actual）除外：panBox 靠滚动条平移，处理器留在 canvas 上避免滚动条
  // 区域把点击漏给远端。
  const stageHandlers = {
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent) => {
      // 按住期间捕获指针：松开发生在画面外（letterbox / 窗口外）时，
      // mouseup 仍会派发到本元素——否则按键在远端卡死在按下态，
      // 之后任何补发的 UP 都会弹出「凭空」的右键菜单。拖拽出界同理。
      if (!canControl || !hasFrame || !active) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 不支持捕获的环境交给 window 级 mouseup 兜底 */
      }
    },
    onMouseMove: (e: React.MouseEvent) => {
      if (!canControl || !hasFrame || !active || input.pointerLocked) return;
      const r = input.norm(e);
      if (r) input.queueMove(r.x, r.y);
    },
    // B1：down/up 同样门控。点在失焦窗口上的那一下先用来唤醒（焦点事件把
    // active 翻真），下一次点击才注入——宁可多点一下，也不让点击落在
    // 一帧早已不更新的旧画面上。配合 RcSessionStage 的暂停提示，不静默。
    onMouseDown: (e: React.MouseEvent) => {
      if (active) input.sendButton(e, true);
    },
    onMouseUp: (e: React.MouseEvent) => {
      if (active) input.sendButton(e, false);
    },
    onWheel: (e: React.WheelEvent) => {
      if (!canControl || !hasFrame || !active) return;
      const r = input.norm(e);
      if (!r) return;
      // 触控板横滑：优先水平分量，否则回退竖直
      const axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      input.noteWheel();
      // 合并发送（16ms 累积）：触控板逐事件转发会洪泛可靠流
      input.sendWheel(r.x, r.y, axis > 0 ? -120 : 120);
    },
  };
  return (
    <div
      className={fit === "actual" ? styles.panBox : styles.fitBox}
      style={
        fit === "actual"
          ? undefined
          : { width: "100%", height: "100%", cursor: baseCursor }
      }
      {...(fit === "actual" ? {} : stageHandlers)}
    >
      <div
        className={styles.canvasWrap}
        style={
          fit === "actual"
            ? { position: "relative", width: "fit-content", height: "fit-content" }
            : undefined
        }
      >
        <canvas
          ref={canvasRef}
          className={styles.screenCanvas}
          style={canvasStyle}
          {...(fit === "actual" ? stageHandlers : {})}
        />
        {/* B1：本地光标 overlay。跟随发送坐标即时移动，不等对端画面回传；按下时轻微缩放。
            P1-6：远端非箭头形状时改用系统光标，overlay 让位。 */}
        {useOverlay && input.cursor && cursorPos && (
          <div
            className={input.cursorPressed ? styles.cursorDotPressed : styles.cursorDot}
            style={cursorPos}
            aria-hidden
          >
            <MousePointer2 size={18} strokeWidth={1.6} />
          </div>
        )}
      </div>
    </div>
  );
}
