/**
 * todoisland-main —— 待办灵动岛（Todo Island）的独立入口。
 *
 * 岛是**屏幕顶部居中的常驻小窗**：它不属于任何 PastePanda 页面，
 * 而是浮在全部应用之上的一层。用户在看别的应用时也必须能看到「今天还剩几件」，
 * 所以它必须是独立 webview —— 主窗口的 zustand store、`app-toast` DOM 事件、
 * 任何主窗口内的状态，它一个都拿不到。
 *
 * 🔴 保持极简：不引 appStore、不引主窗口任何状态。
 * 状态只能经 Rust 的 `todo-island-update` 广播过来，而 `lib/todo/islandBridge.ts`
 * 是唯一的推送出口（B2 接真数据时建立）。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TodoIsland } from "./components/todo/TodoIsland";
import { logger } from "./lib/logger";
import { applyTheme, isDarkTheme, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";

// 主题跟随（方案 A，design/待办灵动岛-主题亮暗适配-设计稿.html）：与 screenshot-main.tsx
// 同款三步——首帧兜底、异步拉真值、听广播实时跟。岛只要亮暗二档：把主题的 dark 标志
// 映射成 html[data-island-mode]，两套材质取值都在 TodoIsland.module.css 的变量块里。
function applyIslandTheme(raw?: string) {
  const key = normalizeTheme(raw);
  applyTheme(key);
  document.documentElement.dataset.islandMode = isDarkTheme(key) ? "dark" : "light";
}
// CSS 默认值是深色（= 深海/午夜用户零变化）；这里兜底 DEFAULT（ocean=浅），
// 浅色主题用户在配置拉到前会翻一次面——毫秒级，与截图窗同款代价。
applyIslandTheme();
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyIslandTheme(cfg?.theme))
  .catch(() => { /* 读取失败时保持默认主题 */ });
listen<{ theme?: string }>("theme-changed", (e) => {
  applyIslandTheme(e.payload?.theme);
}).catch(() => { /* 监听注册失败时退化为仅打开时读取一次 */ });

window.addEventListener("error", (event) => {
  logger.error("待办灵动岛未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("待办灵动岛未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TodoIsland />
  </React.StrictMode>,
);
