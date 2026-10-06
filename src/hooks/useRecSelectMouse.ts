/**
 * useRecSelectMouse — 录屏选区的**鼠标状态机**（规则 7 拆分）。
 *
 * 拥有选区相关的全部状态与手柄：预览悬停高亮（方案 A：单击=录窗口）、
 * 拖拽框选 + 吸附、单击采纳、确认态来源标记（窗口/自由框选，提示条文案分叉用）。
 * phase 由组件持有（倒计时/录制/失败也读它），这里只做 preview→dragging→confirm
 * 的推进与回退；可吸附窗口列表（截图同源 enum_window_rects）也归这里拉取。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inRect, normalizeEven, pickSnapCandidate, toLocalCssRect, type Rect } from "@/components/recsel/snap";
import type { RecScreenInfo } from "@/lib/api/rec";

export type Phase = "preview" | "dragging" | "confirm" | "countdown" | "recording" | "failed";

export function useRecSelectMouse(
  phase: Phase,
  setPhase: (p: Phase) => void,
  screen: RecScreenInfo | null,
) {
  const [rect, setRect] = useState<Rect | null>(null); // CSS 坐标（窗口内）
  const [hoverRect, setHoverRect] = useState<Rect | null>(null); // 预览态悬停高亮
  const [snapRect, setSnapRect] = useState<Rect | null>(null); // 拖拽中的吸附候选
  const [rectFromWindow, setRectFromWindow] = useState(false); // 选区来源：窗口采纳
  const winRectsRef = useRef<Rect[]>([]);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);
  const hoverAtDown = useRef<Rect | null>(null); // 按下瞬间的悬停目标（单击采纳用它）

  const toCss = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });

  // 可吸附窗口矩形（会话内取一次；窗口在框选期间不会移动）
  useEffect(() => {
    if (!screen) return;
    const dpr = window.devicePixelRatio || 1;
    invoke<{ x: number; y: number; w: number; h: number }[]>("enum_window_rects")
      .then((list) => {
        winRectsRef.current = (list ?? []).map((r) =>
          toLocalCssRect(r, screen.originX, screen.originY, dpr),
        );
      })
      .catch(() => { /* 枚举失败 = 没有吸附候选，自由框选不受影响 */ });
  }, [screen]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (phase !== "preview" && phase !== "confirm") return;
    const t = e.target as HTMLElement;
    // 提示条/确认条（.rec-glass）上的点击不进框选——按钮各自处理（整屏 → 等）
    if (t.closest(".rec-glass")) return;
    if (phase === "confirm" && rect && inRect(toCss(e), rect)) return; // 选区内不触发重画
    // 只在预览态继承悬停目标：confirm 重画时的 hoverRect 是上一次预览的**陈旧值**，
    // 误继承会让「单击选区外重画」凭空采纳几秒前悬停过的窗口（P1，2026-10-05 审查）
    hoverAtDown.current = phase === "preview" ? hoverRect : null;
    setHoverRect(null); // 高亮随预览态结束；回预览后由 mousemove 重新计算
    dragMoved.current = false;
    dragStart.current = toCss(e);
    setRect(null);
    setPhase("dragging");
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (phase === "preview") {
      // 方案 A 悬停高亮：光标下的窗口亮出来，单击就录它；提示条玻璃上不算
      const t = e.target as HTMLElement;
      setHoverRect(t.closest(".rec-glass") ? null : pickSnapCandidate(winRectsRef.current, toCss(e)));
      return;
    }
    if (phase !== "dragging" || !dragStart.current) return;
    const p = toCss(e);
    if (Math.abs(p.x - dragStart.current.x) + Math.abs(p.y - dragStart.current.y) > 3) {
      dragMoved.current = true;
    }
    setSnapRect(pickSnapCandidate(winRectsRef.current, p));
    setRect({
      x: Math.min(dragStart.current.x, p.x),
      y: Math.min(dragStart.current.y, p.y),
      w: Math.abs(p.x - dragStart.current.x),
      h: Math.abs(p.y - dragStart.current.y),
    });
  };

  const onMouseUp = () => {
    if (phase !== "dragging") return;
    dragStart.current = null;
    // 拖拽中吸附到了窗口：松手即采纳窗口矩形（静态区域，窗口移动不跟随——提示条已写明）
    if (dragMoved.current && snapRect) {
      setSnapRect(null);
      setRectFromWindow(true);
      setRect(normalizeEven(snapRect));
      setPhase("confirm");
      return;
    }
    setSnapRect(null);
    if (!dragMoved.current) {
      // 方案 A：单击 = 录按下瞬间悬停高亮的窗口；悬停在桌面空白 = 录整屏（§18 P2 一步到位）
      const target = hoverAtDown.current;
      hoverAtDown.current = null;
      setRectFromWindow(target !== null);
      setRect(target ? normalizeEven(target) : null);
      setPhase("confirm");
      return;
    }
    if (!rect || rect.w < 16 || rect.h < 16) {
      // 太小的框 = 采纳整屏
      setRect(null);
      setPhase("confirm");
      return;
    }
    setRect(normalizeEven(rect));
    setPhase("confirm");
  };

  /** 回到预览（Esc 两级取消 / 重画）：清空全部选区痕迹，悬停等下次移动再算。 */
  const backToPreview = useCallback(() => {
    setRect(null);
    setHoverRect(null);
    setSnapRect(null);
    setRectFromWindow(false);
    hoverAtDown.current = null;
    dragMoved.current = false;
    dragStart.current = null;
    setPhase("preview");
  }, [setPhase]);

  /** 「整屏 →」按钮：与单击桌面空白同效，显式兜底（想录整屏不必挪鼠标）。 */
  const adoptFullscreen = useCallback(() => {
    setHoverRect(null);
    hoverAtDown.current = null;
    setRect(null);
    setRectFromWindow(false);
    setPhase("confirm");
  }, [setPhase]);

  return {
    rect,
    setRect,
    hoverRect,
    snapRect,
    rectFromWindow,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    backToPreview,
    adoptFullscreen,
  };
}
