/**
 * 栈浮标「下一条预览」守卫（2026-09-16）。
 *
 * 背景：浮标是独立 webview，状态唯一出口是 `hudBridge.ts`。预览行加入后，
 * `StackHudState.next` 的取值规则（取 `stackItems[0]`、图片/文件占位、
 * 首行截断、栈空为 null）必须钉住 —— 这份状态还被 Rust 侧缓存
 * （`stack_hud_state` 快照补偿），字段语义漂移会同时污染两条读取路径。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { hudPastedOk, hudAllDone, hudStackModeExited, nextPreview } from "@/lib/stack/hudBridge";

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

function resetStore(stackItems: HistoryItem[] = []) {
  useAppStore.setState({
    history: [],
    stackMode: stackItems.length > 0,
    stackItems,
    stackDoneIds: new Set(),
    stackPasted: 0,
    stackCollected: 0,
    config: { ...useAppStore.getState().config, stack_paste_hotkey: "ctrl+shift+p" },
    _filterCache: null,
  });
}

/** 取所有浮标推送里的 state 参数 */
function pushedStates(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "stack_hud_update")
    .map((c) => (c[1] as { state: Record<string, unknown> }).state);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  resetStore();
});

describe("nextPreview（预览取值规则）", () => {
  it("空栈 → null", () => {
    resetStore([]);
    expect(nextPreview()).toBeNull();
  });

  it("文字条目 → 原文", () => {
    resetStore([makeItem({ id: "a", text: "hello" })]);
    expect(nextPreview()).toBe("hello");
  });

  it("多行文字 → 第一个非空行（跳过前导空行）", () => {
    resetStore([makeItem({ id: "a", text: "\n\n  张三\t北京  \n李四" })]);
    expect(nextPreview()).toBe("张三\t北京");
  });

  it("全空白文字 → 占位符，不留一行空白", () => {
    resetStore([makeItem({ id: "a", text: "  \n \n" })]);
    expect(nextPreview()).toBe("[空内容]");
  });

  it("图片条目 → [图片] 占位", () => {
    resetStore([makeItem({ id: "i", text: "", type: "image", content: "C:\\img.png" })]);
    expect(nextPreview()).toBe("[图片]");
  });

  it("文件条目 → [文件] 占位", () => {
    resetStore([makeItem({ id: "f", text: "", type: "file", content: "C:\\a.txt" })]);
    expect(nextPreview()).toBe("[文件]");
  });

  it("超长文字截到 30 字 + 省略号（CSS 省略号之前先控负载）", () => {
    resetStore([makeItem({ id: "a", text: "字".repeat(50) })]);
    const preview = nextPreview();
    expect(preview).toBe("字".repeat(30) + "…");
  });
});

describe("推送状态里的 next 字段", () => {
  it("hudPastedOk：预览 = 弹出后的新栈顶（下一条）", async () => {
    resetStore([makeItem({ id: "b", text: "second" })]);
    await hudPastedOk(1);
    const state = pushedStates()[pushedStates().length - 1]!;
    expect(state.phase).toBe("success");
    expect(state.next).toBe("second");
  });

  it("hudAllDone：栈空 → next 为 null", () => {
    resetStore([]);
    hudAllDone();
    const state = pushedStates()[pushedStates().length - 1]!;
    expect(state.phase).toBe("done");
    expect(state.next).toBeNull();
  });

  it("hudStackModeExited 不推送状态（立即隐藏），不产生残留 next", () => {
    resetStore([makeItem({ id: "a", text: "x" })]);
    hudStackModeExited();
    expect(pushedStates()).toHaveLength(0);
  });
});

describe("进度徽章 progress 字段", () => {
  it("收集中：0/收集数", async () => {
    resetStore([
      makeItem({ id: "a", text: "1" }),
      makeItem({ id: "b", text: "2" }),
      makeItem({ id: "c", text: "3" }),
    ]);
    // pushCollecting 由 hudStackModeEntered 触发
    const { hudStackModeEntered } = await import("@/lib/stack/hudBridge");
    await hudStackModeEntered();
    const state = pushedStates()[pushedStates().length - 1]!;
    expect(state.phase).toBe("collecting");
    expect(state.progress).toEqual({ done: 0, total: 3 });
  });

  it("粘贴成功：stackPasted 已自增，显示 1/总", async () => {
    resetStore([makeItem({ id: "b", text: "second" })]);
    // 模拟已收集 3 条、粘贴 1 条后的 store 状态
    useAppStore.setState({ stackCollected: 3, stackPasted: 1, stackMode: true });
    await hudPastedOk(2);
    const state = pushedStates()[pushedStates().length - 1]!;
    expect(state.progress).toEqual({ done: 1, total: 3 });
  });

  it("done 终态：progress 为 null（不渲染徽章）", () => {
    resetStore([]);
    hudAllDone();
    const state = pushedStates()[pushedStates().length - 1]!;
    expect(state.phase).toBe("done");
    expect(state.progress).toBeNull();
  });
});
