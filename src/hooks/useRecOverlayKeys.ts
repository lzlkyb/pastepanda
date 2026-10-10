/**
 * useRecOverlayKeys — 录屏选区覆盖层的键盘加速器（规则 7 拆分）。
 *
 * 🔴 这段曾在方案 A 重写时被整段弄丢（2026-10-05 审查）：界面上所有「Esc ××」文案
 * 变成空头支票，倒计时态更是完全无法取消。守卫见 `recOverlayEscapeGuard.test.ts`
 * ——它钉的是**本文件**的 keydown/Escape/两级分支，搬家时别把守卫留在旧文件上。
 *
 * 甲案（2026-10-10）加 Enter：预览/确认态一步开录（规则 17：鼠标全流程可达，
 * 键盘只做加速器）。Enter 在两个位置上刻意让路：
 * - 焦点在按钮/输入控件上 → 交给原生「Enter = 按下该按钮」，否则一次按键两个动作；
 * - ⋯ 浮层展开时 → 用户正在调档位，此刻开录是误触。
 *
 * 监听只挂一次、经 ref 读最新闭包：调用方传的是每次渲染新建的箭头函数，按依赖重挂
 * 会让拖拽期间每一次 mousemove 都 add/remove 一次全局监听（规则 8）。
 */
import { useEffect, useRef } from "react";
import type { Phase } from "./useRecSelectMouse";

export interface RecOverlayKeyHandlers {
  phase: Phase;
  setPhase: (p: Phase) => void;
  /** ⋯ 浮层是否展开：展开时 Esc 先关浮层（§18 两级取消，不许一步退出选屏） */
  settingsOpen: boolean;
  onCloseSettings: () => void;
  onBackToPreview: () => void;
  onQuit: () => void;
  /** Enter = 等价于点当前态的「开始录制」 */
  onStart: () => void;
}

export function useRecOverlayKeys(handlers: RecOverlayKeyHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = ref.current;
      if (e.key === "Enter") {
        if (h.settingsOpen) return;
        if ((e.target as HTMLElement | null)?.closest?.("button,input,select,textarea")) return;
        if (h.phase !== "preview" && h.phase !== "confirm") return;
        e.preventDefault();
        h.onStart();
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (h.settingsOpen) {
        h.onCloseSettings();
      } else if (h.phase === "preview") {
        h.onQuit();
      } else if (h.phase === "dragging" || h.phase === "confirm") {
        h.onBackToPreview();
      } else if (h.phase === "countdown") {
        h.setPhase("confirm");
      }
      // recording 态没有 Esc 出口（设计稿：出口只有停止条）
    };
    // 冒泡期挂（同旧实现）：捕获期会触发 dialogEscapeLayering 守卫的手挂登记要求
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
