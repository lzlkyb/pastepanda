import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 当前 Tauri 窗口是否「可见且在前台」。
 *
 * 红线（claude.md 规则 8：性能）——辅助窗口用 `hide()` 而非 `close()`，
 * WebView 一直活着，里面的轮询 / rAF 会持续烧 CPU。本 hook 暴露窗口可见性，
 * 调用方据此暂停轮询 / 动画。
 *
 * 语义与 SkinScene 的暂停门控同源：初始取 `isVisible()`（隐藏的托盘 / 快捷窗口
 * 一开始就不跑），之后由 `onFocusChanged` 驱动（获焦时必已可见，失焦即暂停）。
 * 非 Tauri 环境（单测 / 浏览器预览）拿不到窗口 API，默认可见、不暂停。
 *
 * 🔴 Android（2026-10-01 真机联调）：tauri 的窗口可见性/焦点状态在移动端
 * **恒报 false 且 FocusChanged 事件不来**，桌面语义整条失效——按它门控会把
 * 帧泵和所有轮询饿死（画面 outbox 攒了 89 帧没人取，会话永远「等待对方画面」，
 * CDP 实测 isVisible=false / isFocused=false / document.visible=true）。
 * Android 分支改用 `document.visibilityState`：Activity 退后台 / 锁屏时
 * WebView 恰好变 hidden，「后台暂停」的性能门控语义不变。
 */
export function useWindowVisible(initialVisible = true): boolean {
  const [visible, setVisible] = useState(initialVisible);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let offVisibility: (() => void) | undefined;
    (async () => {
      if (navigator.userAgent.includes("Android")) {
        const apply = () => {
          if (!cancelled) setVisible(document.visibilityState === "visible");
        };
        apply();
        document.addEventListener("visibilitychange", apply);
        offVisibility = () => document.removeEventListener("visibilitychange", apply);
        return;
      }
      try {
        const w = getCurrentWindow();
        const vis = await w.isVisible();
        if (cancelled) return;
        setVisible(vis);
        const un = await w.onFocusChanged(({ payload: focused }) => {
          if (!cancelled) setVisible(focused);
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* 非 Tauri 环境：视作可见；需要初始隐藏的调用方也能正常预览。 */
        if (!cancelled) setVisible(true);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      offVisibility?.();
    };
  }, []);
  return visible;
}
