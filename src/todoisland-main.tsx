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
import { normalizeGlass } from "./lib/todo/glass";
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

// 遮盖度 20–100（2026-09-26：四档 data-glass → 连续滑杆）。材质面 = CSS 半透明面，
// 配方与派生公式见 TodoIsland.module.css；这里只把数字写成 html 上的 --island-glass。
// 取值/夹取口径收口在 lib/todo/glass.ts（设置页与 appStore 迁移共用）。
function applyIslandGlass(raw?: unknown) {
  document.documentElement.style.setProperty("--island-glass", String(normalizeGlass(raw)));
}

// CSS 默认值是深色（= 深海/午夜用户零变化）；这里兜底 DEFAULT（ocean=浅），
// 浅色主题用户在配置拉到前会翻一次面——毫秒级，与截图窗同款代价。
applyIslandTheme();
applyIslandGlass();
invoke<{ theme?: string; todo_island_glass?: unknown }>("get_config")
  .then((cfg) => {
    applyIslandTheme(cfg?.theme);
    applyIslandGlass(cfg?.todo_island_glass);
  })
  .catch(() => { /* 读取失败时保持默认主题与默认档 */ });
listen<{ theme?: string }>("theme-changed", (e) => {
  applyIslandTheme(e.payload?.theme);
}).catch(() => { /* 监听注册失败时退化为仅打开时读取一次 */ });
// 设置页保存「灵动岛」分区后广播（Rust 侧同一个事件做开关门控）；遮盖度变了就重读。
listen("todo-island-config-changed", () => {
  invoke<{ todo_island_glass?: unknown }>("get_config")
    .then((cfg) => applyIslandGlass(cfg?.todo_island_glass))
    .catch(() => { /* 拉不到就保持当前档，下次变更再同步 */ });
}).catch(() => { /* 同上 */ });
// 拖动中的实时预览（2026-09-26）：设置页每帧只发这个事件，**不碰磁盘**，Rust 也不听它；
// 松手才 save_config + 上面的 config-changed。理由见 config.rs 的 backup_config（全量明文备份）。
listen<number>("todo-island-glass-preview", (e) => {
  applyIslandGlass(e.payload);
}).catch(() => { /* 同上 */ });

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

// 「我画完了」回报（岛点亮的常规信号①，机制见 Rust `first_show`）：连等两帧 RAF
// （commit → 实际上屏）再 invoke，保证后端 `show()` 时窗口里已有内容——
// 旧版只靠 on_page_load + 2.5s 保险丝，保险丝在 dev 冷加载时抢先 show 透明空窗，
// 后面的浏览器窗整个透到「岛上」（2026-09-25 用户实拍他窗标题栏）。
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    invoke("todo_island_page_ready").catch(() => { /* 失败由 6s 兜底保险丝接管 */ });
  }),
);
