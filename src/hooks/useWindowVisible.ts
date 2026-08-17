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
 */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
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
        /* 非 Tauri 环境：保持可见，不暂停 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return visible;
}
