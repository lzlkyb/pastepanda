/**
 * 专注模式状态（稿子 P1-3 / 屏幕②）。
 *
 * 只管状态与进提示 toast 的生命周期，**不管键盘**——Esc 的两级取消
 * （先退专注、再弹关闭守卫）必须与外壳既有的 Esc/Ctrl+S 处理器在同一处裁决，
 * 拆到两个监听器里会打架。键盘在 `FullscreenEditor.tsx` 的 keyboard effect。
 *
 * toast 用「延时关闭」而不是长动画承载唯一出口（稿子设计要点：
 * 进入提示不能成为用户找出口的唯一线索，迷你工具栏热区才是常驻出口）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const TOAST_MS = 3000;

export function useFocusMode() {
  const [focusMode, setFocusMode] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const clearToastTimer = useCallback(() => {
    if (toastTimer.current !== null) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
  }, []);

  const enter = useCallback(() => {
    setFocusMode(true);
    setToastVisible(true);
    clearToastTimer();
    toastTimer.current = window.setTimeout(() => setToastVisible(false), TOAST_MS);
  }, [clearToastTimer]);

  const exit = useCallback(() => {
    setFocusMode(false);
    setToastVisible(false);
    clearToastTimer();
  }, [clearToastTimer]);

  const toggle = useCallback(() => {
    // toggle 走 enter/exit 的语义，保证 toast 与定时器一致
    setFocusMode((v) => {
      if (v) {
        setToastVisible(false);
        clearToastTimer();
        return false;
      }
      setToastVisible(true);
      clearToastTimer();
      toastTimer.current = window.setTimeout(() => setToastVisible(false), TOAST_MS);
      return true;
    });
  }, [clearToastTimer]);

  // 卸载清定时器；组件卸载后 setState 由 React 忽略，但定时器必须清（规则 8.1）
  useEffect(() => clearToastTimer, [clearToastTimer]);

  return { focusMode, toastVisible, enter, exit, toggle } as const;
}
