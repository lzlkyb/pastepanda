/**
 * screenshot-main — 截图标注窗口独立入口（透明全屏覆盖层）。
 *
 * 与主窗口独立 React root；只做截图一件事，不引入 appStore 等主窗口状态。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { logger } from "./lib/logger";
import { applyTheme } from "./lib/theme";
import "./styles/globals.css";
// 独立窗口必须加载主题样式表，否则 var(--dialog-bg)/var(--accent) 等全部无定义
import "./styles/theme.css";
import "./styles/screenshot.css";

window.addEventListener("error", (event) => {
  logger.error("截图窗口未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("截图窗口未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 截图遮罩层固定深色玻璃 UI（不跟随用户主题）：截图是叠加在任意屏幕内容上的
// 覆盖层，浅色工具栏在浅色截图背景上会失去对比度，深色玻璃在所有背景下都清晰。
applyTheme("midnight");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary
      componentName="截图窗口"
      fallback={
        <div style={{ padding: 16, fontSize: 12, textAlign: "center", color: "#fff", background: "rgba(0,0,0,0.7)" }}>
          ⚠️ 截图窗口渲染异常，请按 Esc 关闭
        </div>
      }
    >
      <ScreenshotOverlay />
    </ErrorBoundary>
  </React.StrictMode>,
);
