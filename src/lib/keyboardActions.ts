/**
 * 键盘快捷键决策逻辑（从 App.tsx handleKeyDown 提取的纯函数）
 *
 * 将"按键 + 当前状态 → 应执行的动作"这一决策过程抽离为无副作用的纯函数，
 * 便于单元测试覆盖所有分支，也为后续 useGlobalKeyboard hook 重构提供安全网。
 */

// ===== 动作类型 =====

export type KeyAction =
  | { type: "ignore" }
  | { type: "close_dialog"; dialog: "settings" | "snippets" | "extract" | "shortcuts" | "moveToGroup" }
  | { type: "clear_selection" }
  | { type: "hide_window" }
  | { type: "toggle_shortcuts" }
  | { type: "navigate"; direction: "down" | "up" | "home" | "end" }
  | { type: "paste"; targetId: string }
  | { type: "delete"; ids: string[] }
  | { type: "select_all" }
  | { type: "toggle_pin"; id: string }
  | { type: "undo" }
  | { type: "open_settings" }
  | { type: "quick_preview"; targetId: string }
  | { type: "open_item_detail"; targetId: string };

// ===== 输入状态 =====

export interface KeyEventHandlerState {
  /** 按键事件信息 */
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** 事件目标 tagName */
  targetTagName: string;
  /**
   * 事件目标是不是 `contenteditable`。
   *
   * 🔴 CodeMirror（笔记正文、各类代码编辑器）的输入区是 `<div contenteditable>`，
   * `tagName` 是 DIV——只看 tagName 一个都挡不住。
   */
  targetContentEditable?: boolean;
  /** 输入法正在合成（中文选字）。合成中的按键不能当快捷键。 */
  isComposing?: boolean;
  /**
   * 当前主模式。不传当作 `"record"`（向后兼容旧调用）。
   *
   * 本文件描述的这整套键位服务的是**剪贴板历史列表**，
   * 不在记录模式时它操作的列表压根不在屏幕上。
   */
  appMode?: "record" | "tools" | "knowledge";
  /** 右键菜单是否打开 */
  ctxMenuOpen: boolean;
  /** 各弹窗状态 */
  showSettings: boolean;
  showSnippets: boolean;
  showExtract: boolean;
  showShortcuts: boolean;
  moveToGroup: boolean;
  fileDetailOpen: boolean;
  /** 列表状态 */
  filteredIds: string[];
  selectedIds: string[];
  focusId: string | null;
  /** 选中/聚焦项的类型（用于 Space 分支） */
  focusedItemType?: string;
}

// ===== 列表导航键集合 =====

// ❗ 空格（快速预览）本来漏在名单外，弹窗开着时照样会弹预览。
const LIST_NAV_KEYS = new Set([
  "ArrowDown", "ArrowUp", "Enter", "Delete", "Backspace", "Home", "End", " ",
]);

const LIST_NAV_CTRL_KEYS = new Set(["d", "z", "s", "h", "a"]);

// ===== 主决策函数 =====

export function resolveKeyAction(state: KeyEventHandlerState): KeyAction {
  const { key, ctrlKey, shiftKey, targetTagName } = state;

  // Guard 1: 输入区内按键忽略。
  //
  // 🔴 contenteditable 与输入法合成态必须和 tagName **同一道 guard**，
  // 不能只拦列表导航键：下面那条 `?` 开快捷键帮助带 preventDefault，
  // 漏掉的后果是**在笔记里根本打不出 `?`**；同理空格会弹快速预览、
  // 回车会粘贴历史项、退格会删掉历史条目。
  if (targetTagName === "INPUT" || targetTagName === "TEXTAREA" || targetTagName === "SELECT") {
    return { type: "ignore" };
  }
  if (state.targetContentEditable) {
    return { type: "ignore" };
  }
  if (state.isComposing) {
    return { type: "ignore" };
  }

  // Guard 2: 右键菜单打开时所有按键让位
  if (state.ctxMenuOpen) {
    return { type: "ignore" };
  }

  // Guard 3: 弹窗打开时屏蔽列表导航键（Escape 和 ? 除外）
  const dialogOpen =
    state.showSettings || state.showSnippets || state.showExtract || state.moveToGroup || state.fileDetailOpen;
  const isListNavKey =
    LIST_NAV_KEYS.has(key) || (ctrlKey && LIST_NAV_CTRL_KEYS.has(key));
  if (dialogOpen && key !== "Escape" && key !== "?" && isListNavKey) {
    return { type: "ignore" };
  }

  // Guard 4: 不在记录模式时屏蔽列表导航键。
  // ❗ 只拦列表键：`Escape`（关弹窗/隐藏窗口）与 `?`（快捷键帮助）
  //   在非输入态下属于真全局键位，不能跟着一刀切。
  if ((state.appMode ?? "record") !== "record" && isListNavKey) {
    return { type: "ignore" };
  }

  // === 分支路由 ===

  if (key === "Escape") {
    // U4 分层关闭
    if (state.showSettings) return { type: "close_dialog", dialog: "settings" };
    if (state.showSnippets) return { type: "close_dialog", dialog: "snippets" };
    if (state.showExtract) return { type: "close_dialog", dialog: "extract" };
    if (state.showShortcuts) return { type: "close_dialog", dialog: "shortcuts" };
    if (state.moveToGroup) return { type: "close_dialog", dialog: "moveToGroup" };
    if (state.selectedIds.length > 0) return { type: "clear_selection" };
    return { type: "hide_window" };
  }

  if (key === "?" || (shiftKey && key === "/")) {
    return { type: "toggle_shortcuts" };
  }

  if (key === "ArrowDown") {
    return { type: "navigate", direction: "down" };
  }

  if (key === "ArrowUp") {
    return { type: "navigate", direction: "up" };
  }

  if (key === "Enter") {
    const targetId = state.focusId || state.selectedIds[0] || null;
    if (targetId) return { type: "paste", targetId };
    return { type: "ignore" };
  }

  if (key === "Delete" || key === "Backspace") {
    if (state.selectedIds.length > 0) return { type: "delete", ids: state.selectedIds };
    if (state.focusId) return { type: "delete", ids: [state.focusId] };
    return { type: "ignore" };
  }

  if (ctrlKey && key === "a") {
    return { type: "select_all" };
  }

  if (ctrlKey && key === "d") {
    const id = state.selectedIds[0] || state.focusId;
    if (id) return { type: "toggle_pin", id };
    return { type: "ignore" };
  }

  if (ctrlKey && key === "z") {
    return { type: "undo" };
  }

  if (ctrlKey && key === "s") {
    return { type: "open_settings" };
  }

  if (ctrlKey && key === "h") {
    return { type: "open_settings" };
  }

  if (key === "Home") {
    return { type: "navigate", direction: "home" };
  }

  if (key === "End") {
    return { type: "navigate", direction: "end" };
  }

  if (key === " ") {
    const targetId = state.selectedIds[0] || state.focusId || null;
    if (!targetId) return { type: "ignore" };
    if (state.focusedItemType === "image" || state.focusedItemType === "file") {
      return { type: "open_item_detail", targetId };
    }
    return { type: "quick_preview", targetId };
  }

  return { type: "ignore" };
}

// ===== 导航索引计算（纯函数） =====

export function computeNavIndex(
  direction: "down" | "up" | "home" | "end",
  currentFocusId: string | null,
  filteredIds: string[],
): number {
  if (filteredIds.length === 0) return -1;

  switch (direction) {
    case "down": {
      const currentIdx = currentFocusId ? filteredIds.indexOf(currentFocusId) : -1;
      return Math.min(currentIdx + 1, filteredIds.length - 1);
    }
    case "up": {
      const currentIdx = currentFocusId ? filteredIds.indexOf(currentFocusId) : filteredIds.length;
      return Math.max(currentIdx - 1, 0);
    }
    case "home":
      return 0;
    case "end":
      return filteredIds.length - 1;
  }
}
