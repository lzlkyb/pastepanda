/**
 * 粘贴信号回写覆盖度（v6.15 埋点的真实缺口）。
 *
 * 背景：`action_events` 里一条 `paste` 都没有——本机 663 次新增复制、8 天，零条。
 * 原因是回写只挂在主窗 Enter 与卡片右键粘贴上，而**全局热键那几条路径全漏了**：
 * 依次粘贴 / 索引粘贴 / 栈粘贴都是热键 emit 给前端、由前端执行，却没记事件。
 *
 * 漏记的后果不止统计少几条：
 * - `VALUE_PRESERVE_SQL` 的「被粘贴过」豁免靠这个信号，天天用热键粘的内容
 *   在过期清理看来等于从未被用过；
 * - v6.15 为 X3（目标应用感知重排）埋的 `paste_index` / `target_cat` 两列
 *   因此一个数据都没收到，「先量再做」根本没量到。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { sequentialPaste, indexPaste, stackPasteNext } from "@/lib/api";
import { logItemPasted } from "@/lib/api/actionEvents";

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

function resetStore(history: HistoryItem[] = []) {
  useAppStore.setState({
    history,
    searchKeyword: "",
    filterType: "all",
    timeFilter: "all",
    sourceFilter: "",
    groupFilter: "all",
    selectedTagIds: [],
    selectedIds: new Set(),
    focusId: null,
    stackMode: false,
    stackItems: [],
    stackDoneIds: new Set(),
    stackPasted: 0,
    stackCollected: 0,
    seqPointer: 0,
    config: { ...useAppStore.getState().config, current_workspace: "默认" },
    _filterCache: null,
  });
}

/** 取所有 action_event_log 调用里的 event 参数 */
function loggedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "action_event_log")
    .map((c) => (c[1] as { event: Record<string, unknown> }).event);
}

/** 等 fire-and-forget 的回写落到 invoke 上（logPasteEvent 内部是异步 IIFE） */
async function waitForPasteEvent() {
  await vi.waitFor(() => {
    expect(loggedEvents().some((e) => e.actionId === "paste")).toBe(true);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ success: true });
  resetStore();
});

describe("logItemPasted（各粘贴点共用的回写入口）", () => {
  it("按条目拼出事件：contentType 优先用 content_type，回退 type", async () => {
    logItemPasted(
      makeItem({ id: "x1", text: "内容", content_type: "json", source: "Code.exe" }),
      3,
    );
    await waitForPasteEvent();

    const ev = loggedEvents().find((e) => e.actionId === "paste")!;
    expect(ev.historyId).toBe("x1");
    expect(ev.contentType).toBe("json");
    expect(ev.pasteIndex).toBe(3);
    expect(ev.outcome).toBe("pasted");
  });

  it("没有 content_type 时回退 type", async () => {
    logItemPasted(makeItem({ id: "x2", text: "内容", type: "image" }), -1);
    await waitForPasteEvent();

    expect(loggedEvents().find((e) => e.actionId === "paste")!.contentType).toBe("image");
  });
});

describe("依次粘贴（Ctrl+Alt+Q）", () => {  it("粘贴成功后回写 paste 信号，带 historyId 与列表下标", async () => {
    resetStore([
      makeItem({ id: "a", text: "第一条" }),
      makeItem({ id: "b", text: "第二条" }),
    ]);

    await sequentialPaste();
    await waitForPasteEvent();

    const ev = loggedEvents().find((e) => e.actionId === "paste");
    expect(ev).toBeDefined();
    expect(ev!.historyId).toBe("a");
    expect(ev!.pasteIndex).toBe(0);
    expect(ev!.outcome).toBe("pasted");
  });

  it("粘贴失败时不回写（否则会把没粘上的内容标成已用过）", async () => {
    resetStore([makeItem({ id: "a", text: "第一条" })]);
    // paste_text 失败 → pasteTextGuarded 返回 false
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "paste_text") return Promise.reject(new Error("粘贴失败"));
      return Promise.resolve({ success: true });
    });

    await sequentialPaste();
    await new Promise((r) => setTimeout(r, 20));

    expect(loggedEvents().some((e) => e.actionId === "paste")).toBe(false);
  });
});

describe("索引粘贴（Ctrl+Alt+1~9）", () => {
  it("粘贴第 2 条后回写下标 1", async () => {
    resetStore([
      makeItem({ id: "a", text: "第一条" }),
      makeItem({ id: "b", text: "第二条" }),
    ]);

    await indexPaste(2);
    await waitForPasteEvent();

    const ev = loggedEvents().find((e) => e.actionId === "paste");
    expect(ev!.historyId).toBe("b");
    expect(ev!.pasteIndex).toBe(1);
  });
});

describe("栈粘贴（Ctrl+Alt+P）", () => {
  it("粘贴栈顶后回写 paste 信号", async () => {
    const item = makeItem({ id: "s1", text: "栈顶内容" });
    resetStore([item]);
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    await stackPasteNext();
    await waitForPasteEvent();

    const ev = loggedEvents().find((e) => e.actionId === "paste");
    expect(ev!.historyId).toBe("s1");
    // 栈粘贴不是从列表浏览选的，按既有约定用 -1
    expect(ev!.pasteIndex).toBe(-1);
  });
});
