import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { TrayPopup } from "./components/TrayPopup";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { invoke } from "@tauri-apps/api/core";
import "./styles/globals.css";
// 托盘弹窗同为独立窗口，必须加载主题样式表，否则 popup.css 里的
// var(--dialog-bg)/var(--accent)/var(--text-*) 全部无定义，弹窗会退化成白底黑字、
// 渐变与边框失效。buttons.css 提供 VersionBadge 徽章样式（自 app.css 迁入，两入口共用）。
import "./styles/theme.css";
import "./styles/buttons.css";
import "./styles/popup.css";

// 托盘弹窗之前没有任何错误兜底，渲染一报错就是永久空白弹窗；本弹窗没有 main.tsx 里的
// ToastProvider，这里只做日志记录，不再尝试弹 toast（问题3）
window.addEventListener("error", (event) => {
  logger.error("托盘弹窗未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("托盘弹窗未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 先同步应用默认主题兜底（避免无样式闪烁），再异步读取用户实际主题，
// 使弹窗外观跟随应用主题（TrayPopup 的 MutationObserver 会自动同步内部 state）
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme((cfg.theme as ThemeKey) || DEFAULT_THEME))
  .catch(() => { /* 读取失败时保持默认主题 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary
      componentName="托盘弹窗"
      fallback={
        <div style={{ padding: 12, fontSize: 12, textAlign: "center", color: "var(--text-muted)" }}>
          ⚠️ 弹窗渲染异常，请重新打开
        </div>
      }
    >
      <MotionConfig reducedMotion="user">
        <TrayPopup />
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
);
