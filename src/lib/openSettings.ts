/**
 * 从任意处打开设置页并定位到指定 tab（A-61 ③）。
 *
 * 为何用 **DOM 事件**而不是把 `showSettings` 提到 store：
 * 那个开关是 `App.tsx` 的本地 `useState`，且它还参与 `dialogOpen` 聚合、
 * ESC 优先级链与 `dialogStatesRef` 快照——提到 store 要动很多处，
 * 而本需求只是「发个信号让它打开」。
 *
 * 也不用 Tauri 的 `emit`：那是**跳窗口**广播，而这里是同一个窗口内的组件通信。
 * （`App.tsx` 里那个 `open-ai-settings` 是 Tauri 事件，因为它真的从 Rust 发过来。）
 *
 * ❗ tab 名字在这里定义一份，`SettingsDialog` 与 `App.tsx` 都从这里 import：
 *   写三份的话加 tab 时必漏一处，而那种错 tsc 拦不住（字符串字面量能隐式对上）。
 */

/** 设置页的 tab。 */
export type SettingsTabName = "general" | "ai" | "mcp" | "help" | "about";

/** DOM 事件名。带 `pp:` 前缀避免与浏览器/库的事件碰名。 */
export const OPEN_SETTINGS_EVENT = "pp:open-settings";

export interface OpenSettingsDetail {
  tab?: SettingsTabName;
}

/** 打开设置页（可选定位到某个 tab）。 */
export function openSettingsTab(tab?: SettingsTabName): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { tab } }),
  );
}
