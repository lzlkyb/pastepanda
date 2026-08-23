import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import {
  pasteText,
  pasteImage,
  copyOnly,
  saveForeground,
  toggleWindow,
  deleteHistory,
  togglePin,
  sequentialPaste,
  indexPaste,
} from "@/lib/api";

// ============================================================
// 辅助：重置 store 到干净状态
// ============================================================
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
}

beforeEach(() => {
  vi.clearAllMocks();
  // 完全重置 mock，包括 mockResolvedValueOnce 队列，并设置默认返回值
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  resetStore();
});

// ============================================================
// pasteText
// ============================================================
describe("pasteText", () => {
  it("calls invoke with paste_text command", async () => {
    await pasteText("hello world");
    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "hello world" });
  });

  it("dispatches app-toast on error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Paste failed"));

    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    await pasteText("test");

    expect(toastSpy).toHaveBeenCalled();
    const detail = toastSpy.mock.calls[0][0].detail;
    expect(detail.message).toContain("粘贴失败");
    expect(detail.type).toBe("error");
  });

  it("does not throw on invoke failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("fail"));
    await expect(pasteText("test")).resolves.toBe(false);
  });
});

// ============================================================
// pasteImage
// ============================================================
describe("pasteImage", () => {
  it("calls invoke with paste_image command", async () => {
    await pasteImage("C:/images/photo.png");
    expect(invoke).toHaveBeenCalledWith("paste_image", {
      imagePath: "C:/images/photo.png",
    });
  });

  it("dispatches app-toast on error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Image paste failed"));

    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    await pasteImage("bad/path.png");

    expect(toastSpy).toHaveBeenCalled();
    expect(toastSpy.mock.calls[0][0].detail.message).toContain("图片粘贴失败");
    expect(toastSpy.mock.calls[0][0].detail.type).toBe("error");
  });
});

// ============================================================
// copyOnly
// ============================================================
describe("copyOnly", () => {
  it("calls invoke with copy_only command", async () => {
    await copyOnly("copy me");
    expect(invoke).toHaveBeenCalledWith("copy_only", { text: "copy me" });
  });

  it("does not throw on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("copy failed"));
    await expect(copyOnly("test")).resolves.toBeUndefined();
  });
});

// ============================================================
// saveForeground
// ============================================================
describe("saveForeground", () => {
  it("calls invoke with save_foreground command", async () => {
    await saveForeground();
    expect(invoke).toHaveBeenCalledWith("save_foreground");
  });

  it("does not throw on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("fail"));
    await expect(saveForeground()).resolves.toBeUndefined();
  });
});

// ============================================================
// toggleWindow
// ============================================================
describe("toggleWindow", () => {
  it("calls invoke with toggle_window command", async () => {
    await toggleWindow();
    expect(invoke).toHaveBeenCalledWith("toggle_window");
  });

  it("does not throw on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("fail"));
    await expect(toggleWindow()).resolves.toBeUndefined();
  });
});

// ============================================================
// deleteHistory
// ============================================================
describe("deleteHistory", () => {
  it("calls invoke with delete_history and returns count", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(2);

    const count = await deleteHistory(["id-1", "id-2"]);

    expect(invoke).toHaveBeenCalledWith("delete_history", {
      ids: ["id-1", "id-2"],
    });
    expect(count).toBe(2);
  });

  it("removes items from store after deletion", async () => {
    useAppStore.setState({
      history: [
        {
          id: "id-1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "id-2",
          text: "B",
          time: "2026-01-01 12:01:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    vi.mocked(invoke).mockResolvedValueOnce(1);
    await deleteHistory(["id-1"]);

    const history = useAppStore.getState().history;
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("id-2");
  });

  it("returns 0 on invoke failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("delete failed"));
    const count = await deleteHistory(["id-1"]);
    expect(count).toBe(0);
  });

  it("dispatches app-toast with count", async () => {
    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    vi.mocked(invoke).mockResolvedValueOnce(3);
    await deleteHistory(["a", "b", "c"]);

    expect(toastSpy).toHaveBeenCalled();
    expect(toastSpy.mock.calls[0][0].detail.message).toContain("3");
  });

  it("dispatches app-toast only if count > 0", async () => {
    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    vi.mocked(invoke).mockResolvedValueOnce(0);
    await deleteHistory(["empty"]);

    expect(toastSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// togglePin
// ============================================================
describe("togglePin", () => {
  it("calls invoke with toggle_pin and returns pinned state", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);

    const pinned = await togglePin("item-1");

    expect(invoke).toHaveBeenCalledWith("toggle_pin", { id: "item-1" });
    expect(pinned).toBe(true);
  });

  it("returns null on failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("pin failed"));
    const pinned = await togglePin("item-1");
    expect(pinned).toBeNull();
  });

  it("toggles pin state in store", async () => {
    const item = {
      id: "item-1",
      text: "A",
      time: "2026-01-01 12:00:00",
      type: "text" as const,
      content: "",
      pinned: false,
      source: "",
      workspace: "默认",
    };
    useAppStore.setState({ history: [item] });

    vi.mocked(invoke).mockResolvedValueOnce(true); // toggle_pin
    vi.mocked(invoke).mockResolvedValueOnce([{ ...item, pinned: true }]); // get_history（窗口重同步）
    await togglePin("item-1");

    expect(useAppStore.getState().history[0].pinned).toBe(true);
  });

  it("resyncs pagination window after pin toggle (offset drift fix)", async () => {
    const itemA = { id: "a", text: "A", time: "2026-01-01 12:00:00", type: "text" as const, content: "", pinned: true, source: "", workspace: "默认" };
    const itemB = { id: "b", text: "B", time: "2026-01-02 12:00:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" };
    useAppStore.setState({ history: [itemA, itemB] });

    vi.mocked(invoke).mockResolvedValueOnce(false); // toggle_pin：取消置顶 a
    vi.mocked(invoke).mockResolvedValueOnce([itemB, { ...itemA, pinned: false }]); // get_history：新行序
    await togglePin("a");

    // 重同步应以 offset=0、limit=已加载条数 重新拉取
    expect(invoke).toHaveBeenCalledWith("get_history", {
      workspace: "默认",
      filter: "all",
      search: "",
      offset: 0,
      limit: 2,
    });
    // 窗口被替换为后端最新行序（a 落回 b 之后）
    const h = useAppStore.getState().history;
    expect(h.map((i) => i.id)).toEqual(["b", "a"]);
    expect(h[1].pinned).toBe(false);
  });

  it("keeps window intact when resync fails", async () => {
    const item = { id: "x", text: "X", time: "2026-01-01 12:00:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" };
    useAppStore.setState({ history: [item] });

    vi.mocked(invoke).mockResolvedValueOnce(true); // toggle_pin 成功
    vi.mocked(invoke).mockRejectedValueOnce(new Error("db busy")); // get_history 失败
    const pinned = await togglePin("x");

    // pin 本身仍然成功，窗口保留（仅本地翻转 pinned）
    expect(pinned).toBe(true);
    const h = useAppStore.getState().history;
    expect(h).toHaveLength(1);
    expect(h[0].pinned).toBe(true);
  });

  it("dispatches pin-anim event for the list glide animation", async () => {
    const item = { id: "p1", text: "P", time: "2026-01-01 12:00:00", type: "text" as const, content: "", pinned: false, source: "", workspace: "默认" };
    useAppStore.setState({ history: [item] });

    vi.mocked(invoke).mockResolvedValueOnce(true); // toggle_pin
    vi.mocked(invoke).mockResolvedValueOnce([{ ...item, pinned: true }]); // get_history（窗口重同步）
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("pin-anim", listener);
    try {
      await togglePin("p1");
    } finally {
      window.removeEventListener("pin-anim", listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ id: "p1", pinned: true });
  });
});

// ============================================================
// sequentialPaste
// ============================================================
describe("sequentialPaste", () => {
  it("pastes first text item and advances pointer", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "First",
          time: "2026-01-01 12:00:01", // 更新 → 排序后在前
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "2",
          text: "Second",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
      seqPointer: 0,
    });

    await sequentialPaste();

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "First" });
    expect(useAppStore.getState().seqPointer).toBe(1);
  });

  it("does nothing when no text items", async () => {
    useAppStore.setState({
      history: [
        {
          id: "img-1",
          text: "",
          time: "2026-01-01 12:00:00",
          type: "image",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
      seqPointer: 0,
    });

    await sequentialPaste();

    // invoke 不应被调用（因为过滤后没有 text 类型）
    expect(invoke).not.toHaveBeenCalled();
  });

  it("loops when sequential_loop is enabled", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
      seqPointer: 1, // 已到末尾
      config: {
        ...useAppStore.getState().config,
        sequential_loop: true,
      },
    });

    await sequentialPaste();

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "A" });
    expect(useAppStore.getState().seqPointer).toBe(0); // 循环回到 0
  });

  it("stops at end when sequential_loop is disabled", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
      seqPointer: 1,
      config: {
        ...useAppStore.getState().config,
        sequential_loop: false,
      },
    });

    await sequentialPaste();

    // invoke 不应被调用，因为指针已到末尾且不循环
    expect(invoke).not.toHaveBeenCalled();
  });

  it("dispatches app-toast after paste", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "Hello",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
      seqPointer: 0,
    });

    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    await sequentialPaste();

    expect(toastSpy).toHaveBeenCalled();
    expect(toastSpy.mock.calls[0][0].detail.type).toBe("success");
  });
});

// ============================================================
// indexPaste
// ============================================================
describe("indexPaste", () => {
  it("pastes the nth text item (1-based)", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "2",
          text: "B",
          time: "2026-01-01 12:00:01",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "3",
          text: "C",
          time: "2026-01-01 12:00:02",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    await indexPaste(2); // 粘贴第二条

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "B" });
  });

  it("ignores out-of-range index", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    await indexPaste(5); // 超出范围
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores index 0", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "A",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    await indexPaste(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("skips non-text items in indexing", async () => {
    useAppStore.setState({
      history: [
        {
          id: "img",
          text: "",
          time: "2026-01-01 12:00:00",
          type: "image",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "1",
          text: "Text A",
          time: "2026-01-01 12:00:01",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
        {
          id: "2",
          text: "Text B",
          time: "2026-01-01 12:00:02",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    await indexPaste(2); // 过滤后按时间倒序：Text B(12:00:02) 第1, Text A(12:00:01) 第2

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "Text A" });
  });

  it("dispatches app-toast after paste", async () => {
    useAppStore.setState({
      history: [
        {
          id: "1",
          text: "Hello",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    const toastSpy = vi.fn();
    window.addEventListener("app-toast", toastSpy as any);

    await indexPaste(1);

    expect(toastSpy).toHaveBeenCalled();
    expect(toastSpy.mock.calls[0][0].detail.message).toContain("第 1 条");
  });
});

// ============================================================
// initBackend
// ============================================================
describe("initBackend", () => {
  it("loads initial history, config, groups, tags on init", async () => {
    const { initBackend } = await import("@/lib/api");

    // Mock invoke 依次返回不同的值（C13 修复后顺序：config → history → groups → tags）
    vi.mocked(invoke)
      // get_config（先加载配置）
      .mockResolvedValueOnce({
        theme: "midnight",
        auto_cleanup_days: 7,
        hotkey: "ctrl+shift+v",
        current_workspace: "默认",
        lan_sync_enabled: false,
        always_on_top: false,
        auto_startup: false,
      })
      // get_history
      .mockResolvedValueOnce([
        {
          id: "1",
          text: "Hello",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ])
      // get_groups
      .mockResolvedValueOnce([
        {
          id: "g1",
          name: "Work",
          color: "#FF0000",
          icon: "folder",
          sort_order: 0,
          created_at: "2026-01-01",
        },
      ])
      // get_tags
      .mockResolvedValueOnce([
        {
          id: "t1",
          name: "important",
          color: "#0000FF",
          source: "manual",
          created_at: "2026-01-01",
        },
      ]);

    const cleanup = await initBackend();

    expect(invoke).toHaveBeenCalledWith("get_config");
    expect(invoke).toHaveBeenCalledWith("get_history", expect.any(Object));
    expect(invoke).toHaveBeenCalledWith("get_groups");
    expect(invoke).toHaveBeenCalledWith("get_tags");

    const store = useAppStore.getState();
    expect(store.history).toHaveLength(1);
    // theme 用真实的 ThemeKey：updateConfig 会把非法值归一到 DEFAULT_THEME
    expect(store.config.theme).toBe("midnight");
    expect(store.config.auto_cleanup_days).toBe(7);
    expect(store.groups).toHaveLength(1);
    expect(store.tags).toHaveLength(1);

    // cleanup 应该是函数
    expect(typeof cleanup).toBe("function");
  });

  it("throws when get_history fails (M8: error propagates to App)", async () => {
    const { initBackend } = await import("@/lib/api");

    // C13 修复后顺序：get_config 先（try/catch 内），get_history 后（无 catch，向上抛）
    vi.mocked(invoke)
      .mockResolvedValueOnce({ theme: "light", current_workspace: "默认" }) // get_config 成功
      .mockRejectedValueOnce(new Error("DB error")); // get_history 失败 → 抛出

    await expect(initBackend()).rejects.toThrow("DB error");
  });
});

// ============================================================
// loadMoreHistory
// ============================================================
describe("loadMoreHistory", () => {
  it("loads additional items and appends to history", async () => {
    const { loadMoreHistory } = await import("@/lib/api");

    useAppStore.setState({
      history: [
        {
          id: "existing",
          text: "Old",
          time: "2026-01-01 12:00:00",
          type: "text",
          content: "",
          pinned: false,
          source: "",
          workspace: "默认",
        },
      ],
    });

    vi.mocked(invoke).mockResolvedValue([
      {
        id: "new-1",
        text: "New 1",
        time: "2026-01-01 12:00:01",
        type: "text",
        content: "",
        pinned: false,
        source: "",
        workspace: "默认",
      },
      {
        id: "new-2",
        text: "New 2",
        time: "2026-01-01 12:00:02",
        type: "text",
        content: "",
        pinned: false,
        source: "",
        workspace: "默认",
      },
    ]);

    const hasMore = await loadMoreHistory();

    expect(hasMore).toBe(false); // 2 < 50, 没有更多
    expect(useAppStore.getState().history).toHaveLength(3);
  });

  it("returns true when full page loaded", async () => {
    const { loadMoreHistory } = await import("@/lib/api");

    // 构造 50 条模拟数据
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      text: `Item ${i}`,
      time: "2026-01-01 12:00:00",
      type: "text" as const,
      content: "",
      pinned: false,
      source: "",
      workspace: "默认",
    }));

    vi.mocked(invoke).mockResolvedValue(items);

    const hasMore = await loadMoreHistory();
    expect(hasMore).toBe(true); // 50 条 = 满页
  });

  it("returns false on failure", async () => {
    const { loadMoreHistory } = await import("@/lib/api");

    vi.mocked(invoke).mockRejectedValue(new Error("fail"));

    const hasMore = await loadMoreHistory();
    expect(hasMore).toBe(false);
  });
});

// ============================================================
// getStats
// ============================================================
describe("getStats", () => {
  it("fetches stats from backend", async () => {
    const { getStats } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue({
      total: 100,
      pinned: 5,
      today: 10,
      text_count: 80,
      image_count: 15,
      file_count: 5,
      earliest_time: "2025-01-01 00:00:00",
      db_size_kb: 1024,
    });

    const stats = await getStats("默认");

    expect(invoke).toHaveBeenCalledWith("get_stats", {
      workspace: "默认",
    });
    expect(stats.total).toBe(100);
    expect(stats.pinned).toBe(5);
  });

  it("returns zero stats on failure", async () => {
    const { getStats } = await import("@/lib/api");

    vi.mocked(invoke).mockRejectedValue(new Error("fail"));

    const stats = await getStats("默认");
    // getStats 在失败时返回零值 Stats，不抛异常
    expect(stats.total).toBe(0);
    expect(stats.pinned).toBe(0);
  });
});

// ============================================================
// getStatsDetail
// ============================================================
describe("getStatsDetail", () => {
  it("fetches detailed stats from backend", async () => {
    const { getStatsDetail } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue({
      total: 100,
      pinned: 5,
      today: 10,
      yesterday: 8,
      daily: [
        { date: "2026-07-20", count: 5 },
        { date: "2026-07-21", count: 10 },
      ],
      hours: new Array(24).fill(0),
      text_count: 80,
      image_count: 15,
      file_count: 5,
      sources: [{ source: "Chrome", count: 40, source_icon: null }],
      earliest_time: "2025-01-01 00:00:00",
      db_size_kb: 1024,
    });

    const stats = await getStatsDetail("默认");

    expect(invoke).toHaveBeenCalledWith("get_stats_detail", {
      workspace: "默认",
    });
    expect(stats?.total).toBe(100);
    expect(stats?.yesterday).toBe(8);
    expect(stats?.daily).toHaveLength(2);
    expect(stats?.sources[0].source).toBe("Chrome");
  });

  it("returns null on failure", async () => {
    const { getStatsDetail } = await import("@/lib/api");

    vi.mocked(invoke).mockRejectedValue(new Error("fail"));

    const stats = await getStatsDetail("默认");
    // getStatsDetail 在失败时返回 null（调用方保持加载态），不抛异常
    expect(stats).toBeNull();
  });
});

// ============================================================
// 标签相关 API
// ============================================================
describe("Tag APIs", () => {
  it("fetchTags loads tags into store", async () => {
    const { fetchTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue([
      { id: "t1", name: "urgent", color: "#FF0000", source: "manual", created_at: "2026-01-01" },
      { id: "t2", name: "review", color: "#00FF00", source: "manual", created_at: "2026-01-01" },
    ]);

    await fetchTags();

    expect(invoke).toHaveBeenCalledWith("get_tags");
    expect(useAppStore.getState().tags).toHaveLength(2);
  });

  it("createTag calls invoke and returns tag", async () => {
    const { createTag } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue({
      id: "new-tag",
      name: "new",
      color: "#0000FF",
      source: "manual",
      created_at: "2026-01-01",
    });

    const tag = await createTag("new", "#0000FF");

    expect(invoke).toHaveBeenCalledWith("create_tag", {
      name: "new",
      color: "#0000FF",
    });
    expect(tag).not.toBeNull();
    expect(tag!.id).toBe("new-tag");
  });

  it("createTag returns null on failure", async () => {
    const { createTag } = await import("@/lib/api");

    vi.mocked(invoke).mockRejectedValue(new Error("fail"));

    const tag = await createTag("fail", "#000");
    expect(tag).toBeNull();
  });

  it("deleteTag calls invoke", async () => {
    const { deleteTag } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await deleteTag("t1");

    expect(invoke).toHaveBeenCalledWith("delete_tag", { id: "t1" });
  });

  it("updateTag calls invoke", async () => {
    const { updateTag } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await updateTag("t1", "renamed", "#FF0000");

    expect(invoke).toHaveBeenCalledWith("update_tag", {
      id: "t1",
      name: "renamed",
      color: "#FF0000",
    });
  });
});

// ============================================================
// 分组相关 API
// ============================================================
describe("Group APIs", () => {
  it("fetchGroups loads groups into store", async () => {
    const { fetchGroups } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue([
      { id: "g1", name: "Work", color: "#FF0000", icon: "folder", sort_order: 0, created_at: "2026-01-01" },
    ]);

    await fetchGroups();

    expect(invoke).toHaveBeenCalledWith("get_groups");
    expect(useAppStore.getState().groups).toHaveLength(1);
  });

  it("createGroup calls invoke and returns group", async () => {
    const { createGroup } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue({
      id: "new-g",
      name: "New",
      color: "#FF0000",
      icon: "folder",
      sort_order: 0,
      created_at: "2026-01-01",
    });

    const group = await createGroup("New", "#FF0000", "folder");

    expect(invoke).toHaveBeenCalledWith("create_group", {
      name: "New",
      color: "#FF0000",
      icon: "folder",
    });
    expect(group).not.toBeNull();
    expect(group!.name).toBe("New");
  });

  it("createGroup returns null on failure", async () => {
    const { createGroup } = await import("@/lib/api");

    vi.mocked(invoke).mockRejectedValue(new Error("fail"));

    const group = await createGroup("fail", "#000", "folder");
    expect(group).toBeNull();
  });

  it("deleteGroup calls invoke", async () => {
    const { deleteGroup } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await deleteGroup("g1");

    expect(invoke).toHaveBeenCalledWith("delete_group", { id: "g1" });
  });

  it("updateGroup calls invoke", async () => {
    const { updateGroup } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await updateGroup("g1", "Renamed", "#00FF00", "star");

    expect(invoke).toHaveBeenCalledWith("update_group", {
      id: "g1",
      name: "Renamed",
      color: "#00FF00",
      icon: "star",
    });
  });

  it("reorderGroups calls invoke", async () => {
    const { reorderGroups } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await reorderGroups(["g2", "g1", "g3"]);

    expect(invoke).toHaveBeenCalledWith("reorder_groups", {
      ids: ["g2", "g1", "g3"],
    });
  });

  it("moveToGroup calls invoke", async () => {
    const { moveToGroup } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await moveToGroup(["id-1", "id-2"], "g-target");

    expect(invoke).toHaveBeenCalledWith("move_to_group", {
      historyIds: ["id-1", "id-2"],
      groupId: "g-target",
    });
  });
});

// ============================================================
// 标签关联 API
// ============================================================
describe("Item-Tag APIs", () => {
  it("setItemTags calls invoke", async () => {
    const { setItemTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await setItemTags("item-1", ["t1", "t2"]);

    expect(invoke).toHaveBeenCalledWith("set_item_tags", {
      historyId: "item-1",
      tagIds: ["t1", "t2"],
    });
  });

  it("addItemTags calls invoke", async () => {
    const { addItemTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await addItemTags(["item-1", "item-2"], ["t1"]);

    expect(invoke).toHaveBeenCalledWith("add_item_tags", {
      historyIds: ["item-1", "item-2"],
      tagIds: ["t1"],
    });
  });

  it("removeItemTags calls invoke", async () => {
    const { removeItemTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await removeItemTags(["item-1"], ["t1", "t2"]);

    expect(invoke).toHaveBeenCalledWith("remove_item_tags", {
      historyIds: ["item-1"],
      tagIds: ["t1", "t2"],
    });
  });

  it("getItemsWithTags calls invoke and returns Map", async () => {
    const { getItemsWithTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue([
      ["item-1", [{ id: "t1", name: "urgent", color: "#FF0000", source: "manual", created_at: "" }]],
    ]);

    const result = await getItemsWithTags(["item-1"]);

    expect(invoke).toHaveBeenCalledWith("get_items_with_tags", {
      historyIds: ["item-1"],
    });
    // getItemsWithTags 返回 Map<string, Tag[]>
    expect(result instanceof Map).toBe(true);
    expect(result.size).toBe(1);
    expect(result.get("item-1")).toBeDefined();
    expect(result.get("item-1")![0].name).toBe("urgent");
  });

  it("confirmAutoTags calls invoke", async () => {
    const { confirmAutoTags } = await import("@/lib/api");

    vi.mocked(invoke).mockResolvedValue(undefined);

    await confirmAutoTags("item-1");

    expect(invoke).toHaveBeenCalledWith("confirm_auto_tags", {
      historyId: "item-1",
    });
  });
});

// ============================================================
// invalidateCountsCache
// ============================================================
describe("invalidateCountsCache", () => {
  it("dispatches counts-invalidated event", async () => {
    const { invalidateCountsCache } = await import("@/lib/api");

    const eventSpy = vi.fn();
    window.addEventListener("counts-invalidated", eventSpy);

    invalidateCountsCache();

    expect(eventSpy).toHaveBeenCalled();
  });
});

// ============================================================
// 静默失败补提示（规则 15.3：静默失败比报错难查一个量级）
//
// 这些都是用户在界面上主动点出来的操作，此前失败时只 logger.error 就返回，
// 界面毫无反应——「点了没反应」在用户眼里和「坏了」没区别，而且无从判断。
// 不覆盖后台读取（获取标签/统计/缩略图等，用户没主动要求，弹出来是噪音），
// 也不覆盖已有 toast 的路径（如 pasteText，重复弹更糟）。
// ============================================================
describe("用户操作失败必须可见", () => {
  /** 收集本次调用派发的 app-toast */
  function catchToast() {
    const spy = vi.fn();
    window.addEventListener("app-toast", spy as any);
    return {
      spy,
      cleanup: () => window.removeEventListener("app-toast", spy as any),
      firstMessage: () => (spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail?.message ?? "",
    };
  }

  const CASES: Array<[string, string, (m: Record<string, any>) => Promise<unknown>]> = [
    ["createTag",        "创建标签失败", (m) => m.createTag("x", "#fff")],
    ["updateTag",        "更新标签失败", (m) => m.updateTag("t1", "x", "#fff")],
    ["deleteTag",        "删除标签失败", (m) => m.deleteTag("t1")],
    ["setItemTags",      "设置标签失败", (m) => m.setItemTags("h1", ["t1"])],
    ["addItemTags",      "添加标签失败", (m) => m.addItemTags(["h1"], ["t1"])],
    ["removeItemTags",   "移除标签失败", (m) => m.removeItemTags(["h1"], ["t1"])],
    ["createGroup",      "创建分组失败", (m) => m.createGroup("g", "#fff", "📁")],
    ["updateGroup",      "更新分组失败", (m) => m.updateGroup("g1", { name: "g" })],
    ["deleteGroup",      "删除分组失败", (m) => m.deleteGroup("g1")],
    ["reorderGroups",    "排序分组失败", (m) => m.reorderGroups(["g1", "g2"])],
    ["moveToGroup",      "移动记录失败", (m) => m.moveToGroup(["h1"], "g1")],
  ];

  for (const [name, expected, call] of CASES) {
    it(`${name} 失败时弹出「${expected}」`, async () => {
      const mod = await import("@/lib/api");
      vi.mocked(invoke).mockRejectedValue(new Error("boom"));
      const t = catchToast();

      await call(mod as unknown as Record<string, any>);

      expect(t.firstMessage()).toContain(expected);
      t.cleanup();
    });
  }

  it("copyOnly 失败时弹出「复制失败」", async () => {
    const { copyOnly } = await import("@/lib/api");
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    const t = catchToast();

    await copyOnly("hello");

    expect(t.firstMessage()).toContain("复制失败");
    t.cleanup();
  });

  it("togglePin 失败时弹出「切换置顶失败」", async () => {
    const { togglePin } = await import("@/lib/api");
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    const t = catchToast();

    await togglePin("h1");

    expect(t.firstMessage()).toContain("切换置顶失败");
    t.cleanup();
  });
});
