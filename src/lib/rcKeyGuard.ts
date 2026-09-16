/**
 * rcKeyGuard — 远程会话键盘守卫的纯函数（可从组件/hook 抽离、单测）。
 *
 * 两级 Esc 的设计（design/远程电脑-UI升级-设计稿.html 17.6/18.4）：
 *   捕获键盘时 Esc1 = 释放键盘；Esc2 = 结束会话。
 * 这两级都由挂在 window 上的 useRcInput 处理。会话视图里的 React
 * onKeyDown/onKeyUp 只负责「捕获态不要把 Escape 当成普通键转发给对端」。
 */

/** 当前事件是否为 Esc（兼容 key / code 两种写法）。 */
export function isSessionEscape(e: { key: string; code?: string }): boolean {
  return e.key === "Escape" || e.code === "Escape";
}

/**
 * 捕获态下，是否应当「本地吞掉」Esc、不转发给对端：
 *   - canControl=false → 不吞（本来就没捕获，交给别的逻辑）
 *   - 捕获键盘(kbOn)   → 吞（交给两级 Esc 的第一级：释放键盘）
 *   - 仅指针锁定       → 吞（交给指针锁定那一级：先 exitPointerLock）
 *   - 两者都无         → 不吞（原生 Esc 继续冒泡，走结束会话）
 */
export function shouldSwallowEscape(
  kbOn: boolean,
  pointerLocked: boolean,
  canControl: boolean,
): boolean {
  if (!canControl) return false;
  return kbOn || pointerLocked;
}
