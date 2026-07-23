/**
 * keyboardActions 测试 — 覆盖 App.tsx handleKeyDown 的全部 14 个分支 + 3 个 guard
 * 保护 M4 重构（提取 useGlobalKeyboard hook）
 */
import { describe, it, expect } from "vitest";
import { resolveKeyAction, computeNavIndex, type KeyEventHandlerState } from "../lib/keyboardActions";

// ===== 工厂函数 =====

function makeState(overrides: Partial<KeyEventHandlerState> = {}): KeyEventHandlerState {
  return {
    key: "",
    ctrlKey: false,
    shiftKey: false,
    targetTagName: "DIV",
    ctxMenuOpen: false,
    showSettings: false,
    showSnippets: false,
    showExtract: false,
    showShortcuts: false,
    moveToGroup: false,
    fileDetailOpen: false,
    filteredIds: ["a", "b", "c"],
    selectedIds: [],
    focusId: null,
    focusedItemType: "text",
    ...overrides,
  };
}

// ============================================================
// Guard 条件
// ============================================================
describe("Guard 条件", () => {
  it("输入框内按键被忽略 (INPUT)", () => {
    const action = resolveKeyAction(makeState({ key: "Enter", targetTagName: "INPUT" }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("输入框内按键被忽略 (TEXTAREA)", () => {
    const action = resolveKeyAction(makeState({ key: "ArrowDown", targetTagName: "TEXTAREA" }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("输入框内按键被忽略 (SELECT)", () => {
    const action = resolveKeyAction(makeState({ key: "Delete", targetTagName: "SELECT" }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("右键菜单打开时所有按键让位", () => {
    const action = resolveKeyAction(makeState({ key: "Enter", ctxMenuOpen: true }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("弹窗打开时列表导航键被屏蔽", () => {
    const action = resolveKeyAction(makeState({ key: "ArrowDown", showSettings: true }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("弹窗打开时 Ctrl 组合导航键被屏蔽", () => {
    const action = resolveKeyAction(makeState({ key: "a", ctrlKey: true, showSnippets: true }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("弹窗打开时 Escape 不被屏蔽", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", showSettings: true }));
    expect(action).toEqual({ type: "close_dialog", dialog: "settings" });
  });

  it("弹窗打开时 ? 不被屏蔽", () => {
    const action = resolveKeyAction(makeState({ key: "?", showSettings: true }));
    expect(action).toEqual({ type: "toggle_shortcuts" });
  });

  it("弹窗打开时非导航键不被屏蔽 (如普通字母)", () => {
    // 'x' 不是列表导航键，不应被屏蔽，但也没有对应分支 → ignore
    const action = resolveKeyAction(makeState({ key: "x", showSettings: true }));
    expect(action).toEqual({ type: "ignore" });
  });
});

// ============================================================
// Escape 分层关闭
// ============================================================
describe("Escape 分层关闭", () => {
  it("关闭设置弹窗（最优先）", () => {
    const action = resolveKeyAction(makeState({
      key: "Escape", showSettings: true, showSnippets: true, selectedIds: ["a"],
    }));
    expect(action).toEqual({ type: "close_dialog", dialog: "settings" });
  });

  it("关闭片段弹窗", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", showSnippets: true }));
    expect(action).toEqual({ type: "close_dialog", dialog: "snippets" });
  });

  it("关闭提取弹窗", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", showExtract: true }));
    expect(action).toEqual({ type: "close_dialog", dialog: "extract" });
  });

  it("关闭快捷键面板", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", showShortcuts: true }));
    expect(action).toEqual({ type: "close_dialog", dialog: "shortcuts" });
  });

  it("关闭移动分组弹窗", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", moveToGroup: true }));
    expect(action).toEqual({ type: "close_dialog", dialog: "moveToGroup" });
  });

  it("清除多选", () => {
    const action = resolveKeyAction(makeState({ key: "Escape", selectedIds: ["a", "b"] }));
    expect(action).toEqual({ type: "clear_selection" });
  });

  it("无选中时隐藏窗口", () => {
    const action = resolveKeyAction(makeState({ key: "Escape" }));
    expect(action).toEqual({ type: "hide_window" });
  });
});

// ============================================================
// 快捷键面板切换
// ============================================================
describe("快捷键面板", () => {
  it("? 切换快捷键面板", () => {
    const action = resolveKeyAction(makeState({ key: "?" }));
    expect(action).toEqual({ type: "toggle_shortcuts" });
  });

  it("Shift+/ 切换快捷键面板", () => {
    const action = resolveKeyAction(makeState({ key: "/", shiftKey: true }));
    expect(action).toEqual({ type: "toggle_shortcuts" });
  });
});

// ============================================================
// 方向键导航
// ============================================================
describe("方向键导航", () => {
  it("ArrowDown 返回 navigate down", () => {
    const action = resolveKeyAction(makeState({ key: "ArrowDown" }));
    expect(action).toEqual({ type: "navigate", direction: "down" });
  });

  it("ArrowUp 返回 navigate up", () => {
    const action = resolveKeyAction(makeState({ key: "ArrowUp" }));
    expect(action).toEqual({ type: "navigate", direction: "up" });
  });

  it("Home 返回 navigate home", () => {
    const action = resolveKeyAction(makeState({ key: "Home" }));
    expect(action).toEqual({ type: "navigate", direction: "home" });
  });

  it("End 返回 navigate end", () => {
    const action = resolveKeyAction(makeState({ key: "End" }));
    expect(action).toEqual({ type: "navigate", direction: "end" });
  });
});

// ============================================================
// Enter 粘贴
// ============================================================
describe("Enter 粘贴", () => {
  it("有 focusId 时粘贴聚焦项", () => {
    const action = resolveKeyAction(makeState({ key: "Enter", focusId: "b" }));
    expect(action).toEqual({ type: "paste", targetId: "b" });
  });

  it("无 focusId 时粘贴第一个选中项", () => {
    const action = resolveKeyAction(makeState({ key: "Enter", selectedIds: ["c", "a"] }));
    expect(action).toEqual({ type: "paste", targetId: "c" });
  });

  it("focusId 优先于 selectedIds", () => {
    const action = resolveKeyAction(makeState({ key: "Enter", focusId: "b", selectedIds: ["c"] }));
    expect(action).toEqual({ type: "paste", targetId: "b" });
  });

  it("无目标时忽略", () => {
    const action = resolveKeyAction(makeState({ key: "Enter" }));
    expect(action).toEqual({ type: "ignore" });
  });
});

// ============================================================
// Delete / Backspace 删除
// ============================================================
describe("Delete 删除", () => {
  it("Delete 删除选中项", () => {
    const action = resolveKeyAction(makeState({ key: "Delete", selectedIds: ["a", "b"] }));
    expect(action).toEqual({ type: "delete", ids: ["a", "b"] });
  });

  it("Backspace 删除选中项", () => {
    const action = resolveKeyAction(makeState({ key: "Backspace", selectedIds: ["c"] }));
    expect(action).toEqual({ type: "delete", ids: ["c"] });
  });

  it("无选中时删除聚焦项", () => {
    const action = resolveKeyAction(makeState({ key: "Delete", focusId: "b" }));
    expect(action).toEqual({ type: "delete", ids: ["b"] });
  });

  it("无选中无聚焦时忽略", () => {
    const action = resolveKeyAction(makeState({ key: "Delete" }));
    expect(action).toEqual({ type: "ignore" });
  });
});

// ============================================================
// Ctrl 组合键
// ============================================================
describe("Ctrl 组合键", () => {
  it("Ctrl+A 全选", () => {
    const action = resolveKeyAction(makeState({ key: "a", ctrlKey: true }));
    expect(action).toEqual({ type: "select_all" });
  });

  it("Ctrl+D 置顶选中项", () => {
    const action = resolveKeyAction(makeState({ key: "d", ctrlKey: true, selectedIds: ["a"] }));
    expect(action).toEqual({ type: "toggle_pin", id: "a" });
  });

  it("Ctrl+D 置顶聚焦项（无选中时）", () => {
    const action = resolveKeyAction(makeState({ key: "d", ctrlKey: true, focusId: "b" }));
    expect(action).toEqual({ type: "toggle_pin", id: "b" });
  });

  it("Ctrl+D 无目标时忽略", () => {
    const action = resolveKeyAction(makeState({ key: "d", ctrlKey: true }));
    expect(action).toEqual({ type: "ignore" });
  });

  it("Ctrl+Z 撤销", () => {
    const action = resolveKeyAction(makeState({ key: "z", ctrlKey: true }));
    expect(action).toEqual({ type: "undo" });
  });

  it("Ctrl+S 打开设置", () => {
    const action = resolveKeyAction(makeState({ key: "s", ctrlKey: true }));
    expect(action).toEqual({ type: "open_settings" });
  });

  it("Ctrl+H 打开设置（帮助已整合）", () => {
    const action = resolveKeyAction(makeState({ key: "h", ctrlKey: true }));
    expect(action).toEqual({ type: "open_settings" });
  });
});

// ============================================================
// Space 快速预览
// ============================================================
describe("Space 快速预览", () => {
  it("文本项触发快速预览", () => {
    const action = resolveKeyAction(makeState({
      key: " ", focusId: "a", focusedItemType: "text",
    }));
    expect(action).toEqual({ type: "quick_preview", targetId: "a" });
  });

  it("图片项打开详情", () => {
    const action = resolveKeyAction(makeState({
      key: " ", focusId: "b", focusedItemType: "image",
    }));
    expect(action).toEqual({ type: "open_item_detail", targetId: "b" });
  });

  it("文件项打开详情", () => {
    const action = resolveKeyAction(makeState({
      key: " ", selectedIds: ["c"], focusedItemType: "file",
    }));
    expect(action).toEqual({ type: "open_item_detail", targetId: "c" });
  });

  it("selectedIds 优先于 focusId", () => {
    const action = resolveKeyAction(makeState({
      key: " ", selectedIds: ["x"], focusId: "y", focusedItemType: "text",
    }));
    expect(action).toEqual({ type: "quick_preview", targetId: "x" });
  });

  it("无目标时忽略", () => {
    const action = resolveKeyAction(makeState({ key: " " }));
    expect(action).toEqual({ type: "ignore" });
  });
});

// ============================================================
// 未知按键
// ============================================================
describe("未知按键", () => {
  it("未映射的按键返回 ignore", () => {
    const action = resolveKeyAction(makeState({ key: "F5" }));
    expect(action).toEqual({ type: "ignore" });
  });
});

// ============================================================
// computeNavIndex 导航索引计算
// ============================================================
describe("computeNavIndex", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("down: 从 -1（无焦点）到 0", () => {
    expect(computeNavIndex("down", null, ids)).toBe(0);
  });

  it("down: 从中间向下", () => {
    expect(computeNavIndex("down", "b", ids)).toBe(2);
  });

  it("down: 末尾不越界", () => {
    expect(computeNavIndex("down", "e", ids)).toBe(4);
  });

  it("up: 从末尾向上", () => {
    expect(computeNavIndex("up", "e", ids)).toBe(3);
  });

  it("up: 顶部不越界", () => {
    expect(computeNavIndex("up", "a", ids)).toBe(0);
  });

  it("up: 无焦点时从末尾开始", () => {
    expect(computeNavIndex("up", null, ids)).toBe(4);
  });

  it("home: 总是 0", () => {
    expect(computeNavIndex("home", "c", ids)).toBe(0);
  });

  it("end: 总是最后一项", () => {
    expect(computeNavIndex("end", "a", ids)).toBe(4);
  });

  it("空列表返回 -1", () => {
    expect(computeNavIndex("down", null, [])).toBe(-1);
    expect(computeNavIndex("home", null, [])).toBe(-1);
  });

  it("焦点不在列表中时 down 从头开始", () => {
    expect(computeNavIndex("down", "nonexistent", ids)).toBe(0);
  });
});
