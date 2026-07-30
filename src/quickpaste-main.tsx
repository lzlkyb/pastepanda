import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { QuickPastePanel } from "./components/QuickPastePanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { invoke } from "@tauri-apps/api/core";
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

// 先同步应用默认主题兜底（避免无样式闪烁），再异步读取用户实际主题
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme((cfg.theme as ThemeKey) || DEFAULT_THEME))
  .catch(() => { /* 读取失败时保持默认主题 */ });

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
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
);
