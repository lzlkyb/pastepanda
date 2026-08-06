import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/stores/appStore";

describe("appStore", () => {
  beforeEach(() => {
    // 完整重置 store 状态，避免测试交叉污染
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
      seqPointer: 0,
      paused: false,
      groups: [],
      tags: [],
      _filterCache: null,
      config: {
        ...useAppStore.getState().config,
        current_workspace: "默认",
      },
    });
  });

  it("has correct default config", () => {
    const config = useAppStore.getState().config;
    expect(config.theme).toBe("light");
    expect(config.auto_cleanup_days).toBe(30);
    expect(config.hotkey).toBe("ctrl+alt+v");
    expect(config.current_workspace).toBe("默认");
    expect(config.lan_sync_enabled).toBe(false);
    expect(config.always_on_top).toBe(false);
    expect(config.auto_startup).toBe(false);
  });

  it("can set and filter by search keyword", () => {
    const store = useAppStore.getState();
    store.setSearchKeyword("test");
    expect(useAppStore.getState().searchKeyword).toBe("test");
    store.setSearchKeyword("");
    expect(useAppStore.getState().searchKeyword).toBe("");
  });

  it("can set filter type", () => {
    const store = useAppStore.getState();
    store.setFilterType("pinned");
    expect(useAppStore.getState().filterType).toBe("pinned");
    store.setFilterType("text");
    expect(useAppStore.getState().filterType).toBe("text");
  });

  it("can update config partially", () => {
    const store = useAppStore.getState();
    store.updateConfig({ theme: "dark" });
    expect(useAppStore.getState().config.theme).toBe("dark");
    // Other config values should remain unchanged
    expect(useAppStore.getState().config.auto_cleanup_days).toBe(30);
  });

  it("can add and remove history items", () => {
    const store = useAppStore.getState();
    const item = {
      id: "test-1",
      text: "Hello",
      time: "2026-01-01 12:00:00",
      type: "text" as const,
      content: "",
      pinned: false,
      source: "",
      workspace: "默认",
    };
    store.setHistory([item]);
    expect(useAppStore.getState().history).toHaveLength(1);

    store.removeItems(["test-1"]);
    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it("can undo delete", () => {
    const store = useAppStore.getState();
    const item = {
      id: "test-1",
      text: "Hello",
      time: "2026-01-01 12:00:00",
      type: "text" as const,
      content: "",
      pinned: false,
      source: "",
      workspace: "默认",
    };
    store.setHistory([item]);
    store.removeItems(["test-1"]);
    expect(useAppStore.getState().history).toHaveLength(0);

    const restored = useAppStore.getState().undoDelete();
    expect(restored).not.toBeNull();
    expect(restored![0].id).toBe("test-1");
    expect(useAppStore.getState().history).toHaveLength(1);
  });

  it("can toggle pin", () => {
    const store = useAppStore.getState();
    const item = {
      id: "test-1",
      text: "Hello",
      time: "2026-01-01 12:00:00",
      type: "text" as const,
      content: "",
      pinned: false,
      source: "",
      workspace: "默认",
    };
    store.setHistory([item]);
    store.togglePin("test-1");
    expect(useAppStore.getState().history[0].pinned).toBe(true);
    store.togglePin("test-1");
    expect(useAppStore.getState().history[0].pinned).toBe(false);
  });

  it("can select items", () => {
    const store = useAppStore.getState();
    const items = [
      { id: "1", text: "A", time: "2026-01-01 12:00:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" },
      { id: "2", text: "B", time: "2026-01-01 12:01:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" },
      { id: "3", text: "C", time: "2026-01-01 12:02:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" },
    ];
    store.setHistory(items);

    // Single select (普通点击设 focusId + lastClickedId，不加入 selectedIds)
    store.selectItem("1");
    expect(useAppStore.getState().focusId).toBe("1");
    expect(useAppStore.getState().lastClickedId).toBe("1");
    expect(useAppStore.getState().selectedIds.size).toBe(0);

    // Multi select — Ctrl+点击切换选中状态
    store.selectItem("2", true);
    expect(useAppStore.getState().selectedIds.has("2")).toBe(true);

    // 再次 Ctrl+点击取消选中
    store.selectItem("2", true);
    expect(useAppStore.getState().selectedIds.has("2")).toBe(false);

    // Select all
    store.selectAll();
    expect(useAppStore.getState().selectedIds.size).toBe(3);
  });

  it("「图片」筛选包含图文（rich）—— 口径必须与后端 get_history 一致", () => {
    const store = useAppStore.getState();
    const base = { time: "2026-01-01 12:00:00", content: "", pinned: false, source: "", workspace: "默认" };
    store.setHistory([
      { ...base, id: "t", text: "纯文本", type: "text" as const },
      { ...base, id: "i", text: "[图片] 100x100", type: "image" as const },
      { ...base, id: "r", text: "图文混排", type: "rich" as const },
    ]);

    // 「图片」= 纯图片 + 图文，两者都是带图内容。这个口径散落在前端本地过滤和
    // 后端 5 处 SQL 里，只改一处就会出现"标签页数字和列表条数对不上"这类难查的问题
    store.setFilterType("image");
    expect(
      useAppStore.getState().getFilteredItems().map((h) => h.id).sort()
    ).toEqual(["i", "r"]);

    // 反向断言：「文本」不能被图文污染。rich 也有 text 字段，条件写松了很容易漏进来
    store.setFilterType("text");
    expect(useAppStore.getState().getFilteredItems().map((h) => h.id)).toEqual(["t"]);
  });
});
