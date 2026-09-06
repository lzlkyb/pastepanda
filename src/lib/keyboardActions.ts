/**
 * 键盘快捷键决策逻辑（从 App.tsx handleKeyDown 提取的纯函数）
 *
 * 将"按键 + 当前状态 → 应执行的动作"这一决策过程抽离为无副作用的纯函数，
 * 便于单元测试覆盖所有分支，也为后续 useGlobalKeyboard hook 重构提供安全网。
 */

// ===== 动作类型 =====

/**
 * Esc 分层关闭能关掉的弹窗。顺序就是 `resolveKeyAction` 里的判定顺序。
 *
 * 前五个是 `dialogStore` 管的，后面那批是 `App.tsx` 的局部 state。
 */
export type DialogId =
  | "chain"
  | "chainEdit"
  | "pasteGuard"
  | "profile"
  | "learnings"
  | "settings"
  | "sequential"
  | "snippets"
  | "extract"
  | "encoding"
  | "batchReplace"
  | "configDiff"
  | "shortcuts"
  | "moveToGroup";

export type KeyAction =
  /** 不关我们的事：不拦截，也不 preventDefault。 */
  | { type: "ignore" }
  /**
   * 这个键归我们，但当下没有可做的事——只 `preventDefault`。
   *
   * 🔴 不能拿 `ignore` 代替：旧代码里 `Enter`/`Delete`/`空格` 都是
   * **先 `preventDefault()` 再判断有没有目标**。没选中条目时若不拦，
   * 按空格会把卡片列表整页滚下去。
   */
  | { type: "consume" }
  | { type: "close_dialog"; dialog: DialogId }
  /** Ctrl+Shift+D：自由文本对比。 */
  | { type: "open_free_diff" }
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
  /** 变换枢纽是否打开。开着时**所有**按键让位（枢纽自带 ↑↓/Enter/Esc）。 */
  hubOpen?: boolean;
  /** 各弹窗状态 */
  showSettings: boolean;
  showSnippets: boolean;
  showExtract: boolean;
  showShortcuts: boolean;
  moveToGroup: boolean;
  fileDetailOpen: boolean;
  // 下面这批是 2026-09-06 补齐的——之前模型里没有，于是它与 `App.tsx` 的
  // 实际行为默默地分岔了（测试只测副本，分岔一直没人发现）。
  showSequential?: boolean;
  showEncoding?: boolean;
  showBatchReplace?: boolean;
  showConfigDiff?: boolean;
  /** `dialogStore` 管的那批（卡片编辑 / 链运行 / 粘贴守卫 / 画像 / 里程碑 …）。 */
  anyStoreDialogOpen?: boolean;
  // Esc 分层需要逐个知道是哪一个，不能只看汇总位。
  chainOpen?: boolean;
  chainEditOpen?: boolean;
  pasteGuardOpen?: boolean;
  profileOpen?: boolean;
  learningsOpen?: boolean;
  /**
   * 卡片编辑器 / 笔记弹窗开着。
   *
   * ❗ 它俩是**自己接 Esc** 的（带未保存确认），全局不能代关也不能隐藏窗口——
   *   代关就会跳过那道确认。所以命中时返回 `ignore` 而不是 `close_dialog`。
   */
  editorItemOpen?: boolean;
  noteDraftOpen?: boolean;
  /**
   * 当前可见列表的 id。
   *
   * ❗ `resolveKeyAction` **不读它**（导航下标由 `computeNavIndex` 单独算，
   *   列表从参数传）。留为可选只是为了兼容旧调用；新代码不要传——
   *   每次按键都 `map` 一遍几千条历史是白费。
   */
  filteredIds?: string[];
  selectedIds: string[];
  focusId: string | null;
  /**
   * 目标条目的类型（只有 Space 分支读它）。
   *
   * ❗ 允许传**函数**做惰性求值：算它要 `filtered.find()` 扫一遍列表，
   *   而绝大多数按键根本走不到 Space 分支（在输入框里打字尤其如此）。
   *   传字符串也行，两种都不影响本函数的纯净性。
   */
  focusedItemType?: string | (() => string | undefined);
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

  // Guard 2: 右键菜单打开时所有按键让位（菜单自带方向键/Enter/Esc）
  if (state.ctxMenuOpen) {
    return { type: "ignore" };
  }

  // Guard 2b: 变换枢纽打开时同样让位。
  if (state.hubOpen) {
    return { type: "ignore" };
  }

  // Guard 3: 弹窗打开时屏蔽列表导航键（Escape 和 ? 除外）。
  // ❗ 名单必须与 `App.tsx` 完全一致：漏一个就意味着开着那个弹窗按
  //   Delete/Backspace 会删掉主窗口选中的卡片。
  const dialogOpen =
    state.showSettings ||
    state.showSequential ||
    state.showSnippets ||
    state.showExtract ||
    state.showEncoding ||
    state.showBatchReplace ||
    state.showConfigDiff ||
    state.moveToGroup ||
    state.fileDetailOpen ||
    state.anyStoreDialogOpen;
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
    // U4 Esc 分层：关最上层弹窗 → 关分组弹窗 → 清多选 → 最后才隐藏窗口。
    //
    // ❗ store 型弹窗放最前：之前单独打开链运行器/粘贴守卫按 Esc 会直接
    //   隐藏整个窗口（落到链尾的全局兜底）。
    if (state.chainOpen) return { type: "close_dialog", dialog: "chain" };
    if (state.chainEditOpen) return { type: "close_dialog", dialog: "chainEdit" };
    if (state.pasteGuardOpen) return { type: "close_dialog", dialog: "pasteGuard" };
    if (state.profileOpen) return { type: "close_dialog", dialog: "profile" };
    if (state.learningsOpen) return { type: "close_dialog", dialog: "learnings" };
    // 这两个自带 Esc（含未保存确认），全局不抢；也不能往下落到隐藏窗口。
    if (state.editorItemOpen) return { type: "ignore" };
    if (state.noteDraftOpen) return { type: "ignore" };
    if (state.showSettings) return { type: "close_dialog", dialog: "settings" };
    if (state.showSequential) return { type: "close_dialog", dialog: "sequential" };
    if (state.showSnippets) return { type: "close_dialog", dialog: "snippets" };
    if (state.showExtract) return { type: "close_dialog", dialog: "extract" };
    if (state.showEncoding) return { type: "close_dialog", dialog: "encoding" };
    if (state.showBatchReplace) return { type: "close_dialog", dialog: "batchReplace" };
    if (state.showConfigDiff) return { type: "close_dialog", dialog: "configDiff" };
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
    return { type: "consume" };
  }

  if (key === "Delete" || key === "Backspace") {
    if (state.selectedIds.length > 0) return { type: "delete", ids: state.selectedIds };
    if (state.focusId) return { type: "delete", ids: [state.focusId] };
    return { type: "consume" };
  }

  if (ctrlKey && key === "a") {
    return { type: "select_all" };
  }

  // ❗ Ctrl+D 与 Ctrl+Shift+D 是两件事。按住 Shift 时 `e.key` 是 "D"（大写），
  //   所以上一条的 `key === "d"` 自然不会命中——与 `App.tsx` 同口径。
  if (ctrlKey && !shiftKey && key === "d") {
    const id = state.selectedIds[0] || state.focusId;
    if (id) return { type: "toggle_pin", id };
    return { type: "ignore" };
  }

  if (ctrlKey && shiftKey && key.toLowerCase() === "d") {
    return { type: "open_free_diff" };
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
    // ❗ 返回 `consume` 而不是 `ignore`：不拦的话空格会把列表整页滚下去。
    if (!targetId) return { type: "consume" };
    // 惰性求值就在这一刻发生——只有走到这里才需要扫列表。
    const itemType =
      typeof state.focusedItemType === "function" ? state.focusedItemType() : state.focusedItemType;
    if (itemType === "image" || itemType === "file") {
      return { type: "open_item_detail", targetId };
    }
    if (itemType === "text") return { type: "quick_preview", targetId };
    // ❗ 只有 text 走快速预览。其它类型（如 rich）在旧代码里也是无响应，
    //   不能笼统归给 quick_preview——那会拿不到 text 字段。
    //   但仍要 `consume`：旧代码这条路径也是 preventDefault 过的。
    return { type: "consume" };
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
