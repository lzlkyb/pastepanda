import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { QuickPastePanel } from "./components/QuickPastePanel";
// 快捷面板是**独立窗口、独立 React root**，它有自己一份 zustand 实例。
// 不把守卫弹窗挂进来，面板里调 pasteTextGuarded 会设上 pasteGuard 状态却无人渲染，
// promise 永远不 resolve——粘贴直接卡死，比不守卫更糟。
import { PasteGuardDialog } from "./components/PasteGuardDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { useAppStore } from "./stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles/globals.css";
// 独立窗口必须加载主题样式表，否则 var(--dialog-bg)/var(--accent) 等全部无定义
import "./styles/theme.css";
import "./styles/quickpaste.css";

window.addEventListener("error", (event) => {
  logger.error("快捷粘贴面板未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("快捷粘贴面板未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 先同步应用默认主题兜底（避免无样式闪烁），再异步读取用户实际主题。
// 同时把主题写入本窗口独立 store——SkinScene 读 store.theme 渲染对应场景，
// 独立窗口不与主窗口共享 store，必须在此显式同步。
applyTheme(DEFAULT_THEME);
useAppStore.getState().updateConfig({ theme: DEFAULT_THEME });
invoke<{ theme?: string }>("get_config")
  .then((cfg) => {
    const themeKey = (cfg.theme as ThemeKey) || DEFAULT_THEME;
    applyTheme(themeKey);
    useAppStore.getState().updateConfig({ theme: themeKey });
  })
  .catch(() => { /* 读取失败时保持默认主题 */ });

// 监听主窗口切主题广播，打开期间实时跟随（本面板为热键常驻唤出型，感知最明显）。
// applyTheme 更新 documentElement[data-theme]，updateConfig 同步 store（SkinScene 读 store.theme 渲染场景）。
listen<{ theme?: string }>("theme-changed", (e) => {
  const themeKey = (e.payload.theme as ThemeKey) || DEFAULT_THEME;
  applyTheme(themeKey);
  useAppStore.getState().updateConfig({ theme: themeKey });
}).catch(() => { /* 监听注册失败时退化为仅窗口打开时读取一次 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary
      componentName="快捷粘贴面板"
      fallback={
        <div style={{ padding: 12, fontSize: 12, textAlign: "center", color: "var(--text-muted)" }}>
          ⚠️ 面板渲染异常，请重新打开
        </div>
      }
    >
      <MotionConfig reducedMotion="user">
        <QuickPastePanel />
        <PasteGuardDialog />
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
);
