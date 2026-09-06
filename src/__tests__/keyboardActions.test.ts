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

  it("无目标时不粘贴，但仍拦下按键", () => {
    // 2026-09-06 收口时更正：旧断言是 `ignore`，但 `App.tsx` 里这条路径
    // **是先 preventDefault 再判断有没有目标的**——副本与真代码在这里分岔了。
    // 退化成 ignore 的话，按空格会把卡片列表整页滚下去。
    const action = resolveKeyAction(makeState({ key: "Enter" }));
    expect(action).toEqual({ type: "consume" });
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

  it("无选中无聚焦时不删除，但仍拦下按键", () => {
    // 2026-09-06 收口时更正：旧断言是 `ignore`，但 `App.tsx` 里这条路径
    // **是先 preventDefault 再判断有没有目标的**——副本与真代码在这里分岔了。
    // 退化成 ignore 的话，按空格会把卡片列表整页滚下去。
    const action = resolveKeyAction(makeState({ key: "Delete" }));
    expect(action).toEqual({ type: "consume" });
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

  it("无目标时不预览，但仍拦下按键", () => {
    // 2026-09-06 收口时更正：旧断言是 `ignore`，但 `App.tsx` 里这条路径
    // **是先 preventDefault 再判断有没有目标的**——副本与真代码在这里分岔了。
    // 退化成 ignore 的话，按空格会把卡片列表整页滚下去。
    const action = resolveKeyAction(makeState({ key: " " }));
    expect(action).toEqual({ type: "consume" });
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

/**
 * 2026-09-06 补：用户在知识库模式下报的三条交互问题，根因都在本文件的 guard。
 *
 * 🔴 这些用例锁的是「知识库里打字不该触发剪贴板历史的键位」。
 *    在补它们之前，本测试文件只有 tagName 一道 guard——而笔记正文是
 *    CodeMirror（`<div contenteditable>`，tagName 为 DIV），一条都测不到。
 */
describe("resolveKeyAction — 输入区与视图闸门", () => {
  it("contenteditable 里回车不粘贴历史项（用户报「显示已粘贴图片」）", () => {
    const a = resolveKeyAction(
      makeState({ key: "Enter", targetTagName: "DIV", targetContentEditable: true }),
    );
    expect(a.type).toBe("ignore");
  });

  it("contenteditable 里空格不弹快速预览（用户报「打不出空格」）", () => {
    const a = resolveKeyAction(
      makeState({ key: " ", targetTagName: "DIV", targetContentEditable: true }),
    );
    expect(a.type).toBe("ignore");
  });

  it("contenteditable 里退格不删历史条目（未被报告，审查时发现）", () => {
    const a = resolveKeyAction(
      makeState({
        key: "Backspace",
        targetTagName: "DIV",
        targetContentEditable: true,
        selectedIds: ["a", "b"],
      }),
    );
    expect(a.type).toBe("ignore");
  });

  it("contenteditable 里 `?` 是普通字符，不开快捷键面板", () => {
    const a = resolveKeyAction(
      makeState({ key: "?", targetTagName: "DIV", targetContentEditable: true }),
    );
    expect(a.type).toBe("ignore");
  });

  it("输入法合成中的回车不当快捷键（中文选字）", () => {
    const a = resolveKeyAction(makeState({ key: "Enter", isComposing: true }));
    expect(a.type).toBe("ignore");
  });

  it("知识库模式下列表导航键全部失效", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Delete", "Backspace", "Home", "End", " "]) {
      const a = resolveKeyAction(makeState({ key, appMode: "knowledge", selectedIds: ["a"] }));
      expect(a.type, `key=${JSON.stringify(key)}`).toBe("ignore");
    }
  });

  it("❗ 但知识库模式下 Escape 与 ? 仍然生效（不能一刀切）", () => {
    expect(resolveKeyAction(makeState({ key: "Escape", appMode: "knowledge" })).type).toBe(
      "hide_window",
    );
    expect(resolveKeyAction(makeState({ key: "?", appMode: "knowledge" })).type).toBe(
      "toggle_shortcuts",
    );
  });

  it("不传 appMode 时按记录模式处理（向后兼容旧调用）", () => {
    const a = resolveKeyAction(makeState({ key: "ArrowDown" }));
    expect(a.type).toBe("navigate");
  });
});

/**
 * 2026-09-06：`App.tsx` 的 handleKeyDown 已改为调用 `resolveKeyAction`，
 * 本文件从「测一份副本」变成「测唯一的判断逻辑」。
 *
 * 🔴 下面这批分支**在收口之前从来没被测过**——它们只存在于 App.tsx 里，
 *    模型里压根没有。分岔就是这么发生的。
 */
describe("resolveKeyAction — 收口时从 App.tsx 补进模型的分支", () => {
  it("变换枢纽打开时所有按键让位（含 Escape）", () => {
    for (const key of ["Escape", "ArrowDown", "Enter", "?", " "]) {
      expect(resolveKeyAction(makeState({ key, hubOpen: true })).type).toBe("ignore");
    }
  });

  describe("dialogOpen 名单必须齐 —— 漏一个就意味着开着它按退格会删主列表的卡片", () => {
    const flags = [
      "showSequential", "showEncoding", "showBatchReplace", "showConfigDiff", "anyStoreDialogOpen",
    ] as const;
    for (const flag of flags) {
      it(`${flag} 打开时屏蔽 Delete`, () => {
        const a = resolveKeyAction(makeState({ key: "Delete", selectedIds: ["a"], [flag]: true }));
        expect(a.type).toBe("ignore");
      });
    }
  });

  describe("Esc 分层：store 型弹窗排在局部 state 弹窗之前", () => {
    it("链运行器优先于设置页", () => {
      const a = resolveKeyAction(makeState({ key: "Escape", chainOpen: true, showSettings: true }));
      expect(a).toEqual({ type: "close_dialog", dialog: "chain" });
    });

    it("粘贴守卫单独打开时关自己，不隐藏窗口", () => {
      const a = resolveKeyAction(makeState({ key: "Escape", pasteGuardOpen: true }));
      expect(a).toEqual({ type: "close_dialog", dialog: "pasteGuard" });
    });

    it.each([
      ["chainEditOpen", "chainEdit"],
      ["profileOpen", "profile"],
      ["learningsOpen", "learnings"],
      ["showSequential", "sequential"],
      ["showEncoding", "encoding"],
      ["showBatchReplace", "batchReplace"],
      ["showConfigDiff", "configDiff"],
    ])("%s → 关 %s", (flag, dialog) => {
      const a = resolveKeyAction(makeState({ key: "Escape", [flag]: true }));
      expect(a).toEqual({ type: "close_dialog", dialog });
    });

    it("🔴 卡片编辑器 / 笔记弹窗开着时 Esc 什么都不做", () => {
      // 它俩自己接 Esc（带未保存确认）。代关会跳过确认；往下落又会隐藏整个窗口。
      expect(resolveKeyAction(makeState({ key: "Escape", editorItemOpen: true })).type).toBe("ignore");
      expect(resolveKeyAction(makeState({ key: "Escape", noteDraftOpen: true })).type).toBe("ignore");
    });

    it("❗ 即使同时有多选，编辑器开着也不能退化成「清多选」", () => {
      const a = resolveKeyAction(makeState({ key: "Escape", editorItemOpen: true, selectedIds: ["a"] }));
      expect(a.type).toBe("ignore");
    });
  });

  describe("Ctrl+D 与 Ctrl+Shift+D 是两件事", () => {
    it("Ctrl+D → 置顶", () => {
      const a = resolveKeyAction(makeState({ key: "d", ctrlKey: true, focusId: "a" }));
      expect(a).toEqual({ type: "toggle_pin", id: "a" });
    });

    it("Ctrl+Shift+D → 自由文本对比（按住 Shift 时 key 是大写 D）", () => {
      const a = resolveKeyAction(makeState({ key: "D", ctrlKey: true, shiftKey: true, focusId: "a" }));
      expect(a).toEqual({ type: "open_free_diff" });
    });
  });

  it("空格：只有 text 走快速预览，其它类型（如 rich）不动作但仍拦下按键", () => {
    // 归给 quick_preview 会拿不到 text 字段；而返回 ignore 又会让空格滚页面。
    const a = resolveKeyAction(makeState({ key: " ", focusId: "a", focusedItemType: "rich" }));
    expect(a.type).toBe("consume");
  });

  it("空格：目标条目已不在列表里（类型算不出来）时不动作", () => {
    const a = resolveKeyAction(makeState({ key: " ", focusId: "a", focusedItemType: undefined }));
    expect(a.type).toBe("consume");
  });

  describe("🔴 consume：归我们但没事可做的键仍须 preventDefault", () => {
    // 旧代码里这三个键都是「先 preventDefault 再判断有没有目标」。
    // 退化成 ignore 的话，记录模式下没选中任何条目时按空格会把列表整页滚下去。
    it("空格 + 无选中无焦点", () => {
      expect(resolveKeyAction(makeState({ key: " " })).type).toBe("consume");
    });
    it("Enter + 无选中无焦点", () => {
      expect(resolveKeyAction(makeState({ key: "Enter" })).type).toBe("consume");
    });
    it("Delete + 无选中无焦点", () => {
      expect(resolveKeyAction(makeState({ key: "Delete" })).type).toBe("consume");
    });
    it("而真正不关我们事的键仍是 ignore（不能拦）", () => {
      expect(resolveKeyAction(makeState({ key: "F5" })).type).toBe("ignore");
      expect(resolveKeyAction(makeState({ key: "x" })).type).toBe("ignore");
    });
  });
});
