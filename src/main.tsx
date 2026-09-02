import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { logger } from "./lib/logger";
import "./styles/globals.css";
import "./styles/theme.css";
// 两个模式共用的表面动画。必须在全局层（CSS Modules 会把 keyframes 名字哈希掉）
import "./styles/surface.css";
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

// U55: 把技术性错误信息翻译成用户能看懂的提示（技术细节只进日志）
function friendlyRejectionMessage(reason: unknown): string {
  const raw = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason || "");
  const low = raw.toLowerCase();
  if (low.includes("invoke") || low.includes("command") || low.includes("tauri")) {
    return "应用内部操作失败，请重试";
  }
  if (low.includes("network") || low.includes("fetch") || low.includes("timeout") || low.includes("socket")) {
    return "网络连接失败，请检查网络后重试";
  }
  if (low.includes("denied") || low.includes("permission")) {
    return "操作权限不足，请检查系统设置";
  }
  return "有个后台操作未能完成，可重试一次";
}

window.addEventListener("unhandledrejection", (event) => {
  logger.error("未处理的 Promise 拒绝", event.reason);
  // 防止控制台静默吞掉错误
  event.preventDefault();
  // U55: 发送友好提示，而非原始技术文本
  emitToast(`⚠️ ${friendlyRejectionMessage(event.reason)}`, "error");
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* #3 无障碍：OS「减少动态效果」开启时，framer 自动关闭位移/缩放/布局动画，仅保留淡入淡出 */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <App />
        </ToastProvider>
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
);

// 标记 ToastProvider 已就绪（rAF 确保在 React 初始 effects 之后）
requestAnimationFrame(() => {
  // 再延迟一个宏任务，兜底确保 effects 已全部执行
  setTimeout(flushPendingToasts, 0);
});
