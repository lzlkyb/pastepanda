import React from "react";
import ReactDOM from "react-dom/client";
import { FullscreenEditor } from "./components/editors/FullscreenEditor";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { useAppStore } from "./stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import "./styles/globals.css";

// 编辑器独立窗口：先同步应用默认主题兜底（避免无样式闪烁），
// 再异步读取用户实际主题，使编辑器外观跟随应用主题
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string; window_animation?: boolean }>("get_config")
  .then((cfg) => {
    applyTheme((cfg.theme as ThemeKey) || DEFAULT_THEME);
    // 「窗口动画」关闭：no-anim 类让纯 CSS 入场/退场动画降级为即时显隐，
    // 同时同步到本窗口独立 store，使 ConfirmDialog 等走 useDialogAnim 的组件一致
    if (cfg.window_animation === false) {
      document.documentElement.classList.add("no-anim");
      useAppStore.getState().updateConfig({ window_animation: false });
    }
  })
  .catch(() => { /* 读取失败时保持默认主题 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary componentName="全屏编辑器">
      <ToastProvider>
        <FullscreenEditor />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
