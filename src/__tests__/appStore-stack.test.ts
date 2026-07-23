import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, HistoryItem } from "@/stores/appStore";

/** 创建测试用 HistoryItem */
function makeItem(overrides: Partial<HistoryItem> & { id: string; text: string }): HistoryItem {
  return {
    type: "text" as const,
    time: "2026-01-01 12:00:00",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
    ...overrides,
  };
}

function resetStore() {
  useAppStore.setState({
    history: [],
    searchKeyword: "",
    filterType: "all",
    timeFilter: "all",
    sourceFilter: "",
    groupFilter: "all",
    selectedTagIds: [],
    selectedIds: new Set(),
    focusId: null,
    lastClickedId: null,
    stackMode: false,
    stackItems: [],
    stackDoneIds: new Set(),
    stackPasted: 0,
    stackCollected: 0,
    stackPasteAllActive: false,
    config: {
      ...useAppStore.getState().config,
      current_workspace: "默认",
    },
    _filterCache: null,
  });
}

beforeEach(resetStore);

// ============================================================
// setStackMode
// ============================================================
describe("setStackMode", () => {
  it("activating initializes all stack state to zero/empty", () => {
    // 先制造一些脏状态
    useAppStore.setState({
      stackItems: [makeItem({ id: "x", text: "old" })],
      stackDoneIds: new Set(["x"]),
      stackPasted: 5,
      stackCollected: 10,
    });

    useAppStore.getState().setStackMode(true);
    const s = useAppStore.getState();

    expect(s.stackMode).toBe(true);
    expect(s.stackItems).toEqual([]);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackPasted).toBe(0);
    expect(s.stackCollected).toBe(0);
  });

  it("deactivating only sets stackMode to false (preserves items)", () => {
    const item = makeItem({ id: "a", text: "hello" });
    useAppStore.setState({ stackMode: true, stackItems: [item], stackCollected: 3 });

    useAppStore.getState().setStackMode(false);
    const s = useAppStore.getState();

    expect(s.stackMode).toBe(false);
    // setStackMode(false) 只设 stackMode: false，不清空其他字段
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackCollected).toBe(3);
  });
});

// ============================================================
// stackPush
// ============================================================
describe("stackPush", () => {
  it("is a no-op when stackMode is false", () => {
    const item = makeItem({ id: "1", text: "test" });
    useAppStore.getState().stackPush(item);
    expect(useAppStore.getState().stackItems).toHaveLength(0);
    expect(useAppStore.getState().stackCollected).toBe(0);
  });

  it("adds item to front of stack", () => {
    useAppStore.getState().setStackMode(true);
    const a = makeItem({ id: "a", text: "first" });
    const b = makeItem({ id: "b", text: "second" });

    useAppStore.getState().stackPush(a);
    useAppStore.getState().stackPush(b);

    const s = useAppStore.getState();
    expect(s.stackItems[0].id).toBe("b");
    expect(s.stackItems[1].id).toBe("a");
    expect(s.stackCollected).toBe(2);
  });

  it("deduplicates against stack top (same type + text)", () => {
    useAppStore.getState().setStackMode(true);
    const a = makeItem({ id: "a", text: "same" });
    const b = makeItem({ id: "b", text: "same" });

    useAppStore.getState().stackPush(a);
    useAppStore.getState().stackPush(b); // 与栈顶内容相同 → 跳过

    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].id).toBe("a");
    expect(s.stackCollected).toBe(1); // 未增加
  });

  it("deduplicates image items by content path", () => {
    useAppStore.getState().setStackMode(true);
    const img1 = makeItem({ id: "i1", text: "[图片] 100x100", type: "image", content: "C:\\img.png" });
    const img2 = makeItem({ id: "i2", text: "[图片] 200x200", type: "image", content: "C:\\img.png" });

    useAppStore.getState().stackPush(img1);
    useAppStore.getState().stackPush(img2); // content 相同 → 跳过

    expect(useAppStore.getState().stackItems).toHaveLength(1);
  });

  it("does NOT deduplicate if type differs", () => {
    useAppStore.getState().setStackMode(true);
    const text = makeItem({ id: "t", text: "hello" });
    const file = makeItem({ id: "f", text: "hello", type: "file", content: "C:\\hello.txt" });

    useAppStore.getState().stackPush(text);
    useAppStore.getState().stackPush(file);

    expect(useAppStore.getState().stackItems).toHaveLength(2);
  });

  it("caps at 50 items (removes oldest from bottom)", () => {
    useAppStore.getState().setStackMode(true);
    for (let i = 0; i < 55; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `item-${i}`, text: `text-${i}` }));
    }
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(50);
    // 最新的在前面
    expect(s.stackItems[0].id).toBe("item-54");
    // 最早的 5 条被截掉
    expect(s.stackItems[49].id).toBe("item-5");
    // stackCollected 记录真实总数（不受截断影响）
    expect(s.stackCollected).toBe(55);
  });
});

// ============================================================
// stackMarkPasted
// ============================================================
describe("stackMarkPasted", () => {
  it("is a no-op when stack is empty", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(0);
    expect(s.stackPasted).toBe(0);
    expect(s.stackDoneIds.size).toBe(0);
  });

  it("pops top item, adds to doneIds, increments stackPasted", () => {
    useAppStore.getState().setStackMode(true);
    const a = makeItem({ id: "a", text: "first" });
    const b = makeItem({ id: "b", text: "second" });
    useAppStore.getState().stackPush(a);
    useAppStore.getState().stackPush(b);

    useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();

    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].id).toBe("a"); // b 被弹出
    expect(s.stackDoneIds.has("b")).toBe(true);
    expect(s.stackPasted).toBe(1);
  });

  it("accumulates doneIds across multiple pastes", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackPush(makeItem({ id: "c", text: "3" }));

    useAppStore.getState().stackMarkPasted(); // pops c
    useAppStore.getState().stackMarkPasted(); // pops b

    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].id).toBe("a");
    expect(s.stackDoneIds.has("c")).toBe(true);
    expect(s.stackDoneIds.has("b")).toBe(true);
    expect(s.stackDoneIds.has("a")).toBe(false);
    expect(s.stackPasted).toBe(2);
  });
});

// ============================================================
// exitStackMode
// ============================================================
describe("exitStackMode", () => {
  it("resets ALL stack fields including stackPasteAllActive", () => {
    // 制造完整的脏状态
    useAppStore.setState({
      stackMode: true,
      stackItems: [makeItem({ id: "x", text: "data" })],
      stackDoneIds: new Set(["y"]),
      stackPasted: 7,
      stackCollected: 12,
      stackPasteAllActive: true,
    });

    useAppStore.getState().exitStackMode();
    const s = useAppStore.getState();

    expect(s.stackMode).toBe(false);
    expect(s.stackItems).toEqual([]);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackPasted).toBe(0);
    expect(s.stackCollected).toBe(0);
    expect(s.stackPasteAllActive).toBe(false);
  });

  it("is safe to call when already inactive", () => {
    useAppStore.getState().exitStackMode();
    const s = useAppStore.getState();
    expect(s.stackMode).toBe(false);
    expect(s.stackItems).toEqual([]);
  });
});
