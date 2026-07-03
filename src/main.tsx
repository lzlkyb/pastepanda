import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./lib/logger";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/buttons.css";
import "./styles/dialog.css";
import "./styles/code-theme.css";
import "./styles/app.css";

// 缓存 ToastProvider 挂载前触发的 rejection toast，等 DOM 就绪后批量分发
let toastReady = false;
const pendingToasts: Array<{ message: string; type: string }> = [];

function flushPendingToasts() {
  toastReady = true;
  for (const t of pendingToasts) {
    window.dispatchEvent(new CustomEvent("app-toast", { detail: t }));
  }
  pendingToasts.length = 0;
}

function emitToast(message: string, type: string) {
  const detail = { message, type };
  if (toastReady) {
    window.dispatchEvent(new CustomEvent("app-toast", { detail }));
  } else {
    pendingToasts.push(detail);
  }
}

// 全局未捕获异常处理 — 避免白屏，给用户明确提示
window.addEventListener("error", (event) => {
  logger.error("全局未捕获错误", event.error || event.message);
  // 不阻止默认行为，让 ErrorBoundary 也有机会捕获
});

window.addEventListener("unhandledrejection", (event) => {
  logger.error("未处理的 Promise 拒绝", event.reason);
  // 防止控制台静默吞掉错误
  event.preventDefault();
  // 发送 toast 通知用户
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason || "未知异步错误");
  emitToast(`⚠️ 后台任务异常：${msg.slice(0, 80)}`, "error");
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// 标记 ToastProvider 已就绪（rAF 确保在 React 初始 effects 之后）
requestAnimationFrame(() => {
  // 再延迟一个宏任务，兜底确保 effects 已全部执行
  setTimeout(flushPendingToasts, 0);
});
