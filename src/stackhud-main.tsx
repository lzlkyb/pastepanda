/**
 * stackhud-main —— 剪贴板栈浮标（Stack HUD）的独立入口。
 *
 * 它存在的唯一理由：栈是**无窗口热键**操作 —— `Ctrl+Alt+K` 开栈、在外部应用里
 * `Ctrl+C` 收集、`Ctrl+Alt+P` 粘贴。用户全程的视线与焦点都在**别的应用**里，
 * 而栈的全部反馈（`StackBanner` 横幅、`app-toast` 提示）都渲染在主窗口 webview 里，
 * 他一条都看不到 —— `hotkey-stack-paste` 的回调只 emit 一个事件、不显示任何窗口。
 *
 * 🔴 保持极简：不引 appStore、不引主窗口任何状态。
 * 这是**独立的 webview 与 JS 上下文** —— 主窗口的 zustand store、`app-toast`
 * DOM 事件、任何主窗口内的状态，它一个都拿不到。状态只能经 Rust 的
 * `stack-hud-update` 广播过来，而 `lib/stack/hudBridge.ts` 是唯一的推送出口。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { StackHud } from "./components/stack/StackHud";
import { logger } from "./lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";

window.addEventListener("error", (event) => {
  logger.error("栈浮标未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("栈浮标未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 与长截图状态窗同一套主题跟随：它也是叠在任意屏幕内容上的浮层，
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
    <StackHud />
  </React.StrictMode>,
);
