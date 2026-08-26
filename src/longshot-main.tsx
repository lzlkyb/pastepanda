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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
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

// 与截图窗一致的跟随主题（方案 B）：它也是叠在任意屏幕内容上的浮层，
// 令牌化后浅色主题走浅玻璃 + 深字，深色主题保持深玻璃观感。
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => { /* 读取失败时保持默认主题 */ });

listen<{ theme?: string }>("theme-changed", (e) => {
  applyTheme(normalizeTheme(e.payload?.theme));
}).catch(() => { /* 监听注册失败时退化为仅打开时读取一次 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LongShotStatus />
  </React.StrictMode>,
);
