/**
 * longshot-main —— 长截图状态小窗的独立入口。
 *
 * 它存在的唯一理由：长截图期间截图窗口被 hide()，隐藏的 WebView 既无处显示进度，
 * 也收不到任何按键（旧的"Esc 中止长截图"因此一直是死功能）。
 *
 * 保持极简：不引 appStore、不引主窗口任何状态，只听一个事件、发一个事件。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { LongShotStatus } from "./components/screenshot/LongShotStatus";
import { logger } from "./lib/logger";
import { applyTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/screenshot.css";

window.addEventListener("error", (event) => {
  logger.error("长截图状态窗未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("长截图状态窗未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 与截图窗一致的固定深色玻璃（不跟随用户主题）：它也是叠在任意屏幕内容上的浮层
applyTheme("midnight");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LongShotStatus />
  </React.StrictMode>,
);
