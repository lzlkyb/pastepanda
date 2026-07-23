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
    config: {
      ...useAppStore.getState().config,
      current_workspace: "默认",
    },
    _filterCache: null,
  });
}

beforeEach(resetStore);

// ============================================================
// selectItem — 普通点击
// ============================================================
describe("selectItem — plain click", () => {
  it("sets focusId and lastClickedId", () => {
    useAppStore.getState().selectItem("a");
    const s = useAppStore.getState();
    expect(s.focusId).toBe("a");
    expect(s.lastClickedId).toBe("a");
  });

  it("clears existing multi-selection on plain click (U12 fix)", () => {
    useAppStore.setState({ selectedIds: new Set(["x", "y", "z"]) });
    useAppStore.getState().selectItem("a");
    const s = useAppStore.getState();
    expect(s.selectedIds.size).toBe(0);
    expect(s.focusId).toBe("a");
  });

  it("does NOT clear selection if none exists (no unnecessary Set creation)", () => {
    useAppStore.getState().selectItem("a");
    const s = useAppStore.getState();
    expect(s.selectedIds.size).toBe(0);
  });
});

// ============================================================
// selectItem — Ctrl+点击（多选切换）
// ============================================================
describe("selectItem — multi (Ctrl+click)", () => {
  it("toggles item into selection", () => {
    useAppStore.getState().selectItem("a", true);
    useAppStore.getState().selectItem("b", true);
    const s = useAppStore.getState();
    expect(s.selectedIds.has("a")).toBe(true);
    expect(s.selectedIds.has("b")).toBe(true);
  });

  it("toggles item OUT of selection on second click", () => {
    useAppStore.getState().selectItem("a", true);
    useAppStore.getState().selectItem("a", true);
    expect(useAppStore.getState().selectedIds.has("a")).toBe(false);
  });

  it("updates focusId and lastClickedId", () => {
    useAppStore.getState().selectItem("a", true);
    useAppStore.getState().selectItem("b", true);
    const s = useAppStore.getState();
    expect(s.focusId).toBe("b");
    expect(s.lastClickedId).toBe("b");
  });
});

// ============================================================
// selectItem — Shift+点击（范围选择）
// ============================================================
describe("selectItem — range (Shift+click)", () => {
  it("selects contiguous range between lastClickedId and current", () => {
    // 准备 5 条记录（时间递减 → 排序后 a,b,c,d,e）
    const items = ["a", "b", "c", "d", "e"].map((id, i) =>
      makeItem({ id, text: `item-${id}`, time: `2026-01-0${5 - i} 12:00:00` })
    );
    useAppStore.setState({ history: items, _filterCache: null });

    // 先点 a（设定锚点）
    useAppStore.getState().selectItem("a");
    // Shift+点击 d → 选中 a,b,c,d
    useAppStore.getState().selectItem("d", false, true);

    const s = useAppStore.getState();
    expect(s.selectedIds.has("a")).toBe(true);
    expect(s.selectedIds.has("b")).toBe(true);
    expect(s.selectedIds.has("c")).toBe(true);
    expect(s.selectedIds.has("d")).toBe(true);
    expect(s.selectedIds.has("e")).toBe(false);
  });

  it("range works in reverse direction (bottom to top)", () => {
    const items = ["a", "b", "c", "d", "e"].map((id, i) =>
      makeItem({ id, text: `item-${id}`, time: `2026-01-0${5 - i} 12:00:00` })
    );
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().selectItem("d");
    useAppStore.getState().selectItem("b", false, true);

    const s = useAppStore.getState();
    expect(s.selectedIds.has("b")).toBe(true);
    expect(s.selectedIds.has("c")).toBe(true);
    expect(s.selectedIds.has("d")).toBe(true);
    expect(s.selectedIds.has("a")).toBe(false);
    expect(s.selectedIds.has("e")).toBe(false);
  });

  it("range with no lastClickedId falls back to toggle", () => {
    const items = [makeItem({ id: "a", text: "x" })];
    useAppStore.setState({ history: items, lastClickedId: null, _filterCache: null });

    useAppStore.getState().selectItem("a", false, true);
    // 无锚点时走 else 分支（toggle）
    expect(useAppStore.getState().selectedIds.has("a")).toBe(true);
  });

  it("range adds to existing selection (does not replace)", () => {
    const items = ["a", "b", "c", "d"].map((id, i) =>
      makeItem({ id, text: `item-${id}`, time: `2026-01-0${4 - i} 12:00:00` })
    );
    useAppStore.setState({ history: items, _filterCache: null });

    // 先 Ctrl 选中 d
    useAppStore.getState().selectItem("d", true);
    // 直接设置锚点为 a（避免普通点击触发 U12 清空选中）
    useAppStore.setState({ lastClickedId: "a" });
    // Shift 选 a→c 范围
    useAppStore.getState().selectItem("c", false, true);

    const s = useAppStore.getState();
    expect(s.selectedIds.has("d")).toBe(true); // 保留
    expect(s.selectedIds.has("a")).toBe(true);
    expect(s.selectedIds.has("b")).toBe(true);
    expect(s.selectedIds.has("c")).toBe(true);
  });
});

// ============================================================
// selectAll / clearSelection
// ============================================================
describe("selectAll / clearSelection", () => {
  it("selectAll selects all filtered items", () => {
    const items = ["a", "b", "c"].map((id) => makeItem({ id, text: `t-${id}` }));
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().selectAll();
    const s = useAppStore.getState();
    expect(s.selectedIds.size).toBe(3);
  });

  it("clearSelection resets all selection state", () => {
    useAppStore.setState({
      selectedIds: new Set(["a", "b"]),
      focusId: "a",
      lastClickedId: "b",
    });
    useAppStore.getState().clearSelection();
    const s = useAppStore.getState();
    expect(s.selectedIds.size).toBe(0);
    expect(s.focusId).toBeNull();
    expect(s.lastClickedId).toBeNull();
  });
});

// ============================================================
// setPinned / togglePin — 缓存失效
// ============================================================
describe("setPinned / togglePin — cache invalidation", () => {
  it("setPinned sets authoritative pin state and invalidates cache", () => {
    const items = [makeItem({ id: "a", text: "hello", pinned: false })];
    useAppStore.setState({ history: items, _filterCache: null });

    // 先触发一次 getFilteredItems 建立缓存
    useAppStore.getState().getFilteredItems();
    expect(useAppStore.getState()._filterCache).not.toBeNull();

    // setPinned 应清除缓存
    useAppStore.getState().setPinned("a", true);
    const s = useAppStore.getState();
    expect(s.history[0].pinned).toBe(true);
    expect(s._filterCache).toBeNull();
  });

  it("togglePin flips current state and invalidates cache", () => {
    const items = [makeItem({ id: "a", text: "hello", pinned: false })];
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().getFilteredItems();
    useAppStore.getState().togglePin("a");

    const s = useAppStore.getState();
    expect(s.history[0].pinned).toBe(true);
    expect(s._filterCache).toBeNull();
  });

  it("pinned items sort to top in getFilteredItems", () => {
    const items = [
      makeItem({ id: "a", text: "old", time: "2026-01-01 10:00:00", pinned: false }),
      makeItem({ id: "b", text: "new", time: "2026-01-02 10:00:00", pinned: true }),
    ];
    useAppStore.setState({ history: items, _filterCache: null });

    const filtered = useAppStore.getState().getFilteredItems();
    expect(filtered[0].id).toBe("b"); // pinned first
    expect(filtered[1].id).toBe("a");
  });
});

// ============================================================
// _filterCache 机制
// ============================================================
describe("_filterCache", () => {
  it("returns cached result on second call with same state", () => {
    const items = [makeItem({ id: "a", text: "hello" })];
    useAppStore.setState({ history: items, _filterCache: null });

    const first = useAppStore.getState().getFilteredItems();
    const second = useAppStore.getState().getFilteredItems();
    // 同一引用 → 命中缓存
    expect(first).toBe(second);
  });

  it("invalidates when searchKeyword changes", () => {
    const items = [
      makeItem({ id: "a", text: "hello" }),
      makeItem({ id: "b", text: "world" }),
    ];
    useAppStore.setState({ history: items, _filterCache: null });

    const all = useAppStore.getState().getFilteredItems();
    expect(all).toHaveLength(2);

    useAppStore.getState().setSearchKeyword("hello");
    const filtered = useAppStore.getState().getFilteredItems();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("invalidates when filterType changes", () => {
    const items = [
      makeItem({ id: "a", text: "hello", type: "text" }),
      makeItem({ id: "b", text: "[图片]", type: "image" }),
    ];
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().setFilterType("image");
    const filtered = useAppStore.getState().getFilteredItems();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("invalidates when history length changes", () => {
    const items = [makeItem({ id: "a", text: "hello" })];
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().getFilteredItems();
    expect(useAppStore.getState()._filterCache).not.toBeNull();

    // 添加新记录 → history.length 变化 → 缓存键不同
    useAppStore.setState({
      history: [...items, makeItem({ id: "b", text: "world" })],
      _filterCache: null,
    });
    const filtered = useAppStore.getState().getFilteredItems();
    expect(filtered).toHaveLength(2);
  });

  it("workspace filter excludes other workspaces", () => {
    const items = [
      makeItem({ id: "a", text: "in-default", workspace: "默认" }),
      makeItem({ id: "b", text: "in-work", workspace: "工作" }),
    ];
    useAppStore.setState({ history: items, _filterCache: null });

    const filtered = useAppStore.getState().getFilteredItems();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });
});

// ============================================================
// reorderItems
// ============================================================
describe("reorderItems", () => {
  it("moves item before target and invalidates cache", () => {
    const items = ["a", "b", "c"].map((id) => makeItem({ id, text: `t-${id}` }));
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().getFilteredItems(); // 建立缓存
    useAppStore.getState().reorderItems("c", "a"); // c 移到 a 前面

    const s = useAppStore.getState();
    expect(s.history.map((h) => h.id)).toEqual(["c", "a", "b"]);
    expect(s._filterCache).toBeNull();
  });

  it("is a no-op for invalid ids", () => {
    const items = [makeItem({ id: "a", text: "x" })];
    useAppStore.setState({ history: items, _filterCache: null });

    useAppStore.getState().reorderItems("nonexist", "a");
    expect(useAppStore.getState().history).toHaveLength(1);
  });
});
