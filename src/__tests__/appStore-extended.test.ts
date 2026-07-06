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

describe("appStore — 扩展测试", () => {
  beforeEach(() => {
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
      undoStack: [],
      searchHistory: [],
      config: {
        ...useAppStore.getState().config,
        current_workspace: "默认",
      },
      _filterCache: null,
    });
  });

  // ============================================================
  // 搜索历史
  // ============================================================

  it("addSearchHistory adds unique keywords", () => {
    const store = useAppStore.getState();
    store.addSearchHistory("hello");
    store.addSearchHistory("world");
    store.addSearchHistory("hello"); // 重复应去重并移到前面

    const history = useAppStore.getState().searchHistory;
    expect(history[0]).toBe("hello");
    expect(history[1]).toBe("world");
    expect(history.length).toBe(2);
  });

  it("addSearchHistory ignores empty string", () => {
    const store = useAppStore.getState();
    store.addSearchHistory("");
    store.addSearchHistory("  ");
    expect(useAppStore.getState().searchHistory).toHaveLength(0);
  });

  it("removeSearchHistory removes specific keyword", () => {
    const store = useAppStore.getState();
    store.addSearchHistory("a");
    store.addSearchHistory("b");
    store.removeSearchHistory("a");
    expect(useAppStore.getState().searchHistory).toEqual(["b"]);
  });

  it("clearSearchHistory clears all", () => {
    const store = useAppStore.getState();
    store.addSearchHistory("a");
    store.addSearchHistory("b");
    store.clearSearchHistory();
    expect(useAppStore.getState().searchHistory).toHaveLength(0);
  });

  // ============================================================
  // 时间筛选
  // ============================================================

  it("timeFilter filters items by today", () => {
    const store = useAppStore.getState();
    const today = new Date().toISOString().replace("T", " ").slice(0, 19);
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    store.setHistory([
      makeItem({ id: "1", text: "Today", time: today }),
      makeItem({ id: "2", text: "Yesterday", time: yesterday }),
    ]);

    store.setTimeFilter("today");
    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  it("timeFilter filters items by week", () => {
    const store = useAppStore.getState();
    const recent = new Date().toISOString().replace("T", " ").slice(0, 19);
    const oldDate = new Date(Date.now() - 10 * 86400000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    store.setHistory([
      makeItem({ id: "1", text: "Recent", time: recent }),
      makeItem({ id: "2", text: "Old", time: oldDate }),
    ]);

    store.setTimeFilter("week");
    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  // ============================================================
  // 来源筛选
  // ============================================================

  it("sourceFilter filters by source", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "A", source: "Chrome" }),
      makeItem({ id: "2", text: "B", source: "VS Code" }),
      makeItem({ id: "3", text: "C", source: "Chrome" }),
    ]);

    store.setSourceFilter("Chrome");
    const items = store.getFilteredItems();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === "Chrome")).toBe(true);
  });

  // ============================================================
  // 分组筛选
  // ============================================================

  it("groupFilter filters by group_id", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "No group" }),
      makeItem({ id: "2", text: "Group A", group_id: "g-a" }),
      makeItem({ id: "3", text: "Group B", group_id: "g-b" }),
    ]);

    store.setGroupFilter("g-a");
    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("2");
  });

  it('groupFilter "ungrouped" shows items without group', () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "No group" }),
      makeItem({ id: "2", text: "Group A", group_id: "g-a" }),
    ]);

    store.setGroupFilter("ungrouped");
    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  // ============================================================
  // 标签筛选
  // ============================================================

  it("selectedTagIds filters by tags (AND logic)", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({
        id: "1",
        text: "Both tags",
        tags: [
          { id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" },
          { id: "t2", name: "B", color: "#000", source: "manual" as const, created_at: "" },
        ],
      }),
      makeItem({
        id: "2",
        text: "One tag",
        tags: [
          { id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" },
        ],
      }),
    ]);

    // 筛选同时有 t1 和 t2 的
    useAppStore.setState({ selectedTagIds: ["t1", "t2"] });
    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  it("toggleTagFilter toggles tag id", () => {
    const store = useAppStore.getState();
    store.toggleTagFilter("t1");
    expect(useAppStore.getState().selectedTagIds).toEqual(["t1"]);

    store.toggleTagFilter("t2");
    expect(useAppStore.getState().selectedTagIds).toEqual(["t1", "t2"]);

    store.toggleTagFilter("t1");
    expect(useAppStore.getState().selectedTagIds).toEqual(["t2"]);
  });

  it("clearTagFilters clears all tag filters", () => {
    useAppStore.setState({ selectedTagIds: ["t1", "t2"] });
    useAppStore.getState().clearTagFilters();
    expect(useAppStore.getState().selectedTagIds).toEqual([]);
  });

  // ============================================================
  // 工作空间隔离
  // ============================================================

  it("getFilteredItems filters by current_workspace", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "Default", workspace: "默认" }),
      makeItem({ id: "2", text: "Other", workspace: "项目A" }),
    ]);

    const items = store.getFilteredItems(); // current_workspace = "默认"
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");

    // 切换工作空间
    store.updateConfig({ current_workspace: "项目A" });
    const items2 = store.getFilteredItems();
    expect(items2).toHaveLength(1);
    expect(items2[0].id).toBe("2");
  });

  // ============================================================
  // prependItem 去重
  // ============================================================

  it("prependItem deduplicates by id", () => {
    const store = useAppStore.getState();
    const original = makeItem({
      id: "dup-1",
      text: "Original",
      time: "2026-01-01 10:00:00",
    });
    store.setHistory([original]);

    const updated = makeItem({
      id: "dup-1",
      text: "Updated",
      time: "2026-01-01 11:00:00",
    });
    store.prependItem(updated);

    const history = useAppStore.getState().history;
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe("Updated");
    expect(history[0].time).toBe("2026-01-01 11:00:00");
  });

  it("prependItem limits to 500 items", () => {
    const store = useAppStore.getState();
    const items = Array.from({ length: 500 }, (_, i) =>
      makeItem({ id: `item-${i}`, text: `Item ${i}` })
    );
    store.setHistory(items);

    const newItem = makeItem({ id: "new", text: "New" });
    store.prependItem(newItem);

    const history = useAppStore.getState().history;
    expect(history).toHaveLength(500); // 限制为 500
    expect(history[0].id).toBe("new");
  });

  // ============================================================
  // moveToTop
  // ============================================================

  it("moveToTop moves item to top and updates time", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "First", time: "2026-01-01 10:00:00" }),
      makeItem({ id: "2", text: "Second", time: "2026-01-01 10:00:01" }),
      makeItem({ id: "3", text: "Third", time: "2026-01-01 10:00:02" }),
    ]);

    store.moveToTop("2", "2026-01-01 12:00:00");

    const history = useAppStore.getState().history;
    expect(history[0].id).toBe("2");
    expect(history[0].time).toBe("2026-01-01 12:00:00");
    expect(history).toHaveLength(3);
  });

  // ============================================================
  // reorderItems
  // ============================================================

  it("reorderItems swaps item positions", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "A" }),
      makeItem({ id: "2", text: "B" }),
      makeItem({ id: "3", text: "C" }),
    ]);

    store.reorderItems("3", "1");

    const history = useAppStore.getState().history;
    expect(history[0].id).toBe("3");
    expect(history[1].id).toBe("1");
    expect(history[2].id).toBe("2");
  });

  // ============================================================
  // undoStack 限制
  // ============================================================

  it("undoStack limits to 10 entries", () => {
    const store = useAppStore.getState();
    for (let i = 1; i <= 15; i++) {
      const item = makeItem({ id: `item-${i}`, text: `Item ${i}` });
      store.setHistory([item]);
      store.removeItems([`item-${i}`]);
    }

    expect(useAppStore.getState().undoStack.length).toBeLessThanOrEqual(10);
  });

  // ============================================================
  // seqPointer
  // ============================================================

  it("seqPointer operations work correctly", () => {
    const store = useAppStore.getState();
    store.setSeqPointer(5);
    expect(useAppStore.getState().seqPointer).toBe(5);

    store.resetSeqPointer();
    expect(useAppStore.getState().seqPointer).toBe(0);
  });

  // ============================================================
  // paused
  // ============================================================

  it("paused toggle works", () => {
    const store = useAppStore.getState();
    expect(store.paused).toBe(false);
    store.setPaused(true);
    expect(useAppStore.getState().paused).toBe(true);
  });

  // ============================================================
  // clearAll
  // ============================================================

  it("clearAll resets history and selection", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "A" }),
      makeItem({ id: "2", text: "B" }),
    ]);
    store.selectItem("1");
    store.selectItem("2", true);

    store.clearAll();
    const state = useAppStore.getState();
    expect(state.history).toHaveLength(0);
    expect(state.selectedIds.size).toBe(0);
    expect(state.focusId).toBeNull();
  });

  // ============================================================
  // getSelectedItems
  // ============================================================

  it("getSelectedItems returns selected items", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "A" }),
      makeItem({ id: "2", text: "B" }),
      makeItem({ id: "3", text: "C" }),
    ]);
    // 用 Ctrl+点击选中两个
    store.selectItem("1", true);
    store.selectItem("3", true);

    const selected = store.getSelectedItems();
    expect(selected).toHaveLength(2);
    expect(selected.map((s) => s.id).sort()).toEqual(["1", "3"]);
  });

  // ============================================================
  // getFilteredItems 排序验证
  // ============================================================

  it("getFilteredItems 置顶优先排序", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "Normal A", pinned: false, time: "2026-01-01 12:00:03" }),
      makeItem({ id: "2", text: "Pinned B", pinned: true, time: "2026-01-01 12:00:01" }),
      makeItem({ id: "3", text: "Normal C", pinned: false, time: "2026-01-01 12:00:02" }),
      makeItem({ id: "4", text: "Pinned D", pinned: true, time: "2026-01-01 12:00:00" }),
    ]);

    const items = store.getFilteredItems();
    // 置顶的排在前面，置顶内按时间倒序
    expect(items.map((i) => i.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("getFilteredItems 按时间倒序排列", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "old", text: "Old", time: "2026-01-01 10:00:00" }),
      makeItem({ id: "mid", text: "Mid", time: "2026-01-01 11:00:00" }),
      makeItem({ id: "new", text: "New", time: "2026-01-01 12:00:00" }),
    ]);

    const items = store.getFilteredItems();
    expect(items.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  // ============================================================
  // 组合筛选
  // ============================================================

  it("searchKeyword + filterType 组合筛选", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "Hello World", type: "text", pinned: false }),
      makeItem({ id: "2", text: "Hello Image", type: "image", pinned: false }),
      makeItem({ id: "3", text: "Goodbye", type: "text", pinned: false }),
    ]);
    store.setSearchKeyword("hello");
    store.setFilterType("text");

    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  it("searchKeyword + sourceFilter 组合筛选", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({ id: "1", text: "Code", source: "VS Code" }),
      makeItem({ id: "2", text: "Web Code", source: "Chrome" }),
      makeItem({ id: "3", text: "Code Review", source: "VS Code" }),
    ]);
    store.setSearchKeyword("code");
    store.setSourceFilter("VS Code");

    const items = store.getFilteredItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["1", "3"]);
  });

  it("filterType + timeFilter 组合筛选", () => {
    const store = useAppStore.getState();
    const recent = new Date().toISOString().replace("T", " ").slice(0, 19);
    const oldDate = new Date(Date.now() - 10 * 86400000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    store.setHistory([
      makeItem({ id: "1", text: "Recent text", type: "text", time: recent }),
      makeItem({ id: "2", text: "Old text", type: "text", time: oldDate }),
      makeItem({ id: "3", text: "Recent image", type: "image", time: recent }),
    ]);
    store.setFilterType("text");
    store.setTimeFilter("week");

    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  it("sourceFilter + groupFilter + selectedTagIds 三组合筛选", () => {
    const store = useAppStore.getState();
    store.setHistory([
      makeItem({
        id: "1",
        text: "Match all",
        source: "Chrome",
        group_id: "g-a",
        tags: [{ id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" }],
      }),
      makeItem({
        id: "2",
        text: "Wrong source",
        source: "VS Code",
        group_id: "g-a",
        tags: [{ id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" }],
      }),
      makeItem({
        id: "3",
        text: "Wrong group",
        source: "Chrome",
        group_id: "g-b",
        tags: [{ id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" }],
      }),
      makeItem({
        id: "4",
        text: "Missing tag",
        source: "Chrome",
        group_id: "g-a",
        tags: [],
      }),
    ]);
    store.setSourceFilter("Chrome");
    store.setGroupFilter("g-a");
    useAppStore.setState({ selectedTagIds: ["t1"] });

    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });

  it("全部筛选条件同时生效（searchKeyword + filterType + timeFilter + sourceFilter + groupFilter + selectedTagIds）", () => {
    const store = useAppStore.getState();
    const recent = new Date().toISOString().replace("T", " ").slice(0, 19);

    store.setHistory([
      makeItem({
        id: "1",
        text: "Full match here",
        type: "text",
        time: recent,
        source: "Chrome",
        group_id: "g-a",
        tags: [{ id: "t1", name: "A", color: "#000", source: "manual" as const, created_at: "" }],
      }),
      makeItem({
        id: "2",
        text: "No match at all",
        type: "image",
        time: recent,
        source: "VS Code",
        group_id: "g-b",
        tags: [],
      }),
    ]);
    store.setSearchKeyword("full match");
    store.setFilterType("text");
    store.setTimeFilter("week");
    store.setSourceFilter("Chrome");
    store.setGroupFilter("g-a");
    useAppStore.setState({ selectedTagIds: ["t1"] });

    const items = store.getFilteredItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("1");
  });
});
