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

export type Phase = "preview" | "dragging" | "confirm" | "countdown" | "recording";

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
    // 提示条/确认条（.rec-glass）上的点击不进框选——按钮各自处理（开始录制 / ⋯ / 退出）
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
      // 🔴 甲案 §3 全文规定：**落在玻璃条上不改变目标**，与条下命中判定无关。
      // 改前写的是 `hit === null && closest(".rec-glass")`，只挡「条下恰好是窗外」那一半；
      // 而预览条固定在屏底居中，正常桌面上那些坐标就压在某一扇窗里（最大化窗口铺满屏），
      // 于是「悬停 A → 移向开始录制 → 目标换成盖着条的 B → 按下」仍然会静默录错对象。
      // 我原先注释里那句「玻璃上的坐标多半落在窗外」是没验的假设，作废。
      // 守卫：recSelectStartFromPreview.test.tsx 的**两条**（不带坐标 / 带坐标各钉一半）。
      if (t.closest(".rec-glass")) return;
      setHoverRect(pickSnapCandidate(winRectsRef.current, toCss(e)));
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

  /**
   * 甲案 §1：预览态的终点动作（点「开始录制」/ 按 Enter）直接落子——
   * 有悬停目标就录那扇窗，没有就录整屏，不再要求用户先做一次「含义不明确的点击」。
   * 用 hoverRect 而不是按下瞬间的快照：它现在是粘住的（§3），鼠标移进玻璃条也还在。
   */
  const commitHovered = useCallback(() => {
    const target = hoverRect;
    setRectFromWindow(target !== null);
    setRect(target ? normalizeEven(target) : null);
    setHoverRect(null);
    hoverAtDown.current = null;
  }, [hoverRect, setRect]);

  /**
   * 读数即控制（2026-10-10 上线前审查 P1，规则 17 鼠标全流程可达）：
   * 「整屏」是甲案的默认主张，可一旦光标命中任何窗口，鼠标就没有办法再表达默认值
   * （桌面被最大化窗铺满时 `pickSnapCandidate` 永远非 null），只能靠拖一个全屏框
   * 或者 Esc 退出整个覆盖层。这一句把粘住的悬停目标**放弃**回整屏。
   * 🔴 只清 hoverRect 就够：点它时指针正在玻璃条上，上面那条无条件早退会保住这个 null，
   * 直到用户真的移到另一扇窗上才重新成立新目标（= 设计稿 §3 的规则 ①）。
   */
  const clearHover = useCallback(() => {
    setHoverRect(null);
    hoverAtDown.current = null;
  }, []);

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
    commitHovered,
    clearHover,
  };
}
