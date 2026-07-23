import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import {
  toggleStackMode,
  exitStack,
  stackPasteNext,
  stackPasteAll,
  isStackPasteAllRunning,
  abortStackPasteAll,
} from "@/lib/api";

// ============================================================
// 辅助
// ============================================================
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
      stack_paste_hotkey: "ctrl+shift+p",
    },
    _filterCache: null,
  });
}

/** 收集 app-toast 事件 */
function collectToasts(): { messages: string[]; cleanup: () => void } {
  const messages: string[] = [];
  const handler = (e: Event) => {
    messages.push((e as CustomEvent).detail.message);
  };
  window.addEventListener("app-toast", handler);
  return { messages, cleanup: () => window.removeEventListener("app-toast", handler) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// toggleStackMode
// ============================================================
describe("toggleStackMode", () => {
  it("activates stack mode and toasts hint", () => {
    const { messages, cleanup } = collectToasts();
    toggleStackMode();

    expect(useAppStore.getState().stackMode).toBe(true);
    expect(messages.some((m) => m.includes("栈模式已开启"))).toBe(true);
    // 同步后端
    expect(invoke).toHaveBeenCalledWith("set_stack_mode", { active: true });
    cleanup();
  });

  it("deactivates stack mode and toasts exit", () => {
    useAppStore.setState({ stackMode: true, stackItems: [makeItem({ id: "a", text: "x" })] });
    const { messages, cleanup } = collectToasts();

    toggleStackMode();

    expect(useAppStore.getState().stackMode).toBe(false);
    expect(useAppStore.getState().stackItems).toHaveLength(0);
    expect(messages.some((m) => m.includes("栈模式已退出"))).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_stack_mode", { active: false });
    cleanup();
  });
});

// ============================================================
// exitStack
// ============================================================
describe("exitStack", () => {
  it("exits stack mode and syncs backend", () => {
    useAppStore.setState({ stackMode: true, stackItems: [makeItem({ id: "a", text: "x" })] });
    const { messages, cleanup } = collectToasts();

    exitStack();

    expect(useAppStore.getState().stackMode).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_stack_mode", { active: false });
    expect(messages.some((m) => m.includes("栈模式已退出"))).toBe(true);
    cleanup();
  });
});

// ============================================================
// stackPasteNext
// ============================================================
describe("stackPasteNext", () => {
  it("returns false when not in stack mode", async () => {
    const result = await stackPasteNext();
    expect(result).toBe(false);
  });

  it("auto-exits when stack is empty", async () => {
    useAppStore.setState({ stackMode: true, stackItems: [] });
    const { messages, cleanup } = collectToasts();

    const result = await stackPasteNext();

    expect(result).toBe(false);
    expect(useAppStore.getState().stackMode).toBe(false);
    expect(messages.some((m) => m.includes("栈已清空"))).toBe(true);
    cleanup();
  });

  it("pastes text item and pops from stack", async () => {
    const item = makeItem({ id: "a", text: "hello world" });
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    const result = await stackPasteNext();

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "hello world" });
    // 粘贴成功后弹出 → 栈空 → 自动退出（exitStackMode 重置所有栈状态）
    expect(useAppStore.getState().stackMode).toBe(false);
    expect(useAppStore.getState().stackItems).toHaveLength(0);
  });

  it("pastes image item via paste_image", async () => {
    const item = makeItem({ id: "img", text: "[图片]", type: "image", content: "C:\\img.png" });
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    const result = await stackPasteNext();

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith("paste_image", { imagePath: "C:\\img.png" });
  });

  it("pastes file item via paste_text with content path", async () => {
    const item = makeItem({ id: "f", text: "file.txt", type: "file", content: "C:\\file.txt" });
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    const result = await stackPasteNext();

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "C:\\file.txt" });
  });

  it("returns false and does NOT pop when paste fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("paste error"));
    const item = makeItem({ id: "a", text: "fail" });
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    const result = await stackPasteNext();

    expect(result).toBe(false);
    // 栈不变
    expect(useAppStore.getState().stackItems).toHaveLength(1);
    expect(useAppStore.getState().stackDoneIds.size).toBe(0);
  });

  it("toasts remaining count when items remain", async () => {
    const items = [
      makeItem({ id: "a", text: "first" }),
      makeItem({ id: "b", text: "second" }),
    ];
    useAppStore.setState({ stackMode: true, stackItems: items });
    const { messages, cleanup } = collectToasts();

    await stackPasteNext();

    expect(messages.some((m) => m.includes("剩余 1 条"))).toBe(true);
    expect(useAppStore.getState().stackMode).toBe(true); // 还有剩余，不退出
    cleanup();
  });

  it("toasts completion when last item pasted", async () => {
    const item = makeItem({ id: "a", text: "only" });
    useAppStore.setState({ stackMode: true, stackItems: [item] });
    const { messages, cleanup } = collectToasts();

    await stackPasteNext();

    expect(messages.some((m) => m.includes("全部粘贴完毕"))).toBe(true);
    expect(useAppStore.getState().stackMode).toBe(false);
    cleanup();
  });
});

// ============================================================
// stackPasteAll + abort
// ============================================================
describe("stackPasteAll", () => {
  it("isStackPasteAllRunning returns false when idle", () => {
    expect(isStackPasteAllRunning()).toBe(false);
  });

  it("abortStackPasteAll is a no-op when not running", () => {
    abortStackPasteAll(); // 不应抛错
    expect(isStackPasteAllRunning()).toBe(false);
  });

  it("does nothing when not in stack mode", async () => {
    await stackPasteAll();
    expect(invoke).not.toHaveBeenCalledWith("paste_text", expect.anything());
  });

  it("does nothing when stack is empty", async () => {
    useAppStore.setState({ stackMode: true, stackItems: [] });
    await stackPasteAll();
    expect(invoke).not.toHaveBeenCalledWith("paste_text", expect.anything());
  });

  it("pastes all items sequentially then exits", async () => {
    const items = [
      makeItem({ id: "a", text: "first" }),
      makeItem({ id: "b", text: "second" }),
    ];
    useAppStore.setState({ stackMode: true, stackItems: items });

    await stackPasteAll();

    // exitStackMode 会重置 stackPasted，所以用 invoke 调用次数验证
    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "first" });
    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "second" });
    expect(useAppStore.getState().stackItems).toHaveLength(0);
    expect(useAppStore.getState().stackMode).toBe(false);
    expect(useAppStore.getState().stackPasteAllActive).toBe(false);
    expect(isStackPasteAllRunning()).toBe(false);
  }, 10000);

  it("sets stackPasteAllActive during execution", async () => {
    const items = [makeItem({ id: "a", text: "x" }), makeItem({ id: "b", text: "y" })];
    useAppStore.setState({ stackMode: true, stackItems: items });

    const promise = stackPasteAll();
    // 给一个 tick 让函数启动
    await new Promise((r) => setTimeout(r, 10));
    expect(useAppStore.getState().stackPasteAllActive).toBe(true);
    expect(isStackPasteAllRunning()).toBe(true);

    await promise;
    expect(useAppStore.getState().stackPasteAllActive).toBe(false);
    expect(isStackPasteAllRunning()).toBe(false);
  }, 10000);

  it("abortStackPasteAll stops the loop mid-way", async () => {
    const items = [
      makeItem({ id: "a", text: "1" }),
      makeItem({ id: "b", text: "2" }),
      makeItem({ id: "c", text: "3" }),
      makeItem({ id: "d", text: "4" }),
      makeItem({ id: "e", text: "5" }),
    ];
    useAppStore.setState({ stackMode: true, stackItems: items });
    const { messages, cleanup } = collectToasts();

    const promise = stackPasteAll();
    // 等待第一条粘贴完成（~50ms 足够 invoke 微任务 + 第一个 100ms sleep 开始）
    await new Promise((r) => setTimeout(r, 150));
    abortStackPasteAll();

    await promise;

    // 应该没有粘贴完全部 5 条
    expect(useAppStore.getState().stackPasted).toBeLessThan(5);
    expect(useAppStore.getState().stackPasted).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().stackPasteAllActive).toBe(false);
    expect(isStackPasteAllRunning()).toBe(false);
    expect(messages.some((m) => m.includes("已中止全部粘贴"))).toBe(true);
    cleanup();
  }, 10000);

  it("prevents concurrent stackPasteAll calls", async () => {
    const items = [makeItem({ id: "a", text: "x" }), makeItem({ id: "b", text: "y" })];
    useAppStore.setState({ stackMode: true, stackItems: items });

    const p1 = stackPasteAll();
    const p2 = stackPasteAll(); // 第二次调用应直接返回（stackPasteAllRunning=true）

    await Promise.all([p1, p2]);

    // 只粘贴了一轮（2 次 paste_text 调用），不是 4 次
    const pasteCalls = vi.mocked(invoke).mock.calls.filter(
      ([cmd]) => cmd === "paste_text"
    );
    expect(pasteCalls).toHaveLength(2);
  }, 10000);
});
