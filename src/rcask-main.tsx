/**
 * rcask-main —— 丙-①：入站远程申请**置顶浮层**（窗口 `rc-ask`）的独立入口。
 *
 * 它存在的理由（设计稿 §丙-① 现状那一栏）：告知已经有了（`RcOverlay` toast +
 * `summonMainWindow`），但拉起的是**非置顶**主窗——用户正被全屏应用盖着、或手动把
 * 窗口收回去时，120s 确认窗就在没人看见的地方走完。这块浮层只做一件事：把「有人要
 * 远程这台电脑」顶到手头的活之上，答完就消失。
 *
 * 🔴 保持极简（与 `stackhud-main.tsx` 同一条约束）：**独立 webview、独立 JS 上下文**，
 * 主窗口的 zustand store、`app-toast` DOM 事件一个都拿不到。状态只能挂载时
 * `rc_ask_state()` 主动问一次，之后跟着 `rc-session-changed` 重拉。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RcAskPop } from "./components/rc/RcAskPop";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/buttons.css";

window.addEventListener("error", (event) => {
  logger.error("入站申请浮层未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("入站申请浮层未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 浮层压在任意应用之上，必须跟系统里那套主题走（浅色主题下深玻璃会糊成一块黑）
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => {
    /* 读取失败时保持默认主题 */
  });

listen<{ theme?: string }>("theme-changed", (e) => {
  applyTheme(normalizeTheme(e.payload?.theme));
}).catch(() => {
  /* 监听注册失败时退化为仅打开时读取一次 */
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RcAskPop />
  </React.StrictMode>,
);
