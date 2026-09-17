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

/**
 * 🔴 三个「无窗口热键」入口必须**都**带 `trigger: headless`。
 *
 * 这是 `paste_engine.rs::PasteTrigger` 文档里列的那三条清单
 * （栈粘贴 / 索引粘贴 / 依次粘贴），也是 `hotkey_manager.rs` 里回调结构完全相同的三条
 * —— 都是 `save_foreground_hwnd()` + `emit`，**都不显示任何窗口**。
 *
 * 为什么必须专门守：正因为三者结构一样，「改了一条忘了另两条」是**完全无声的**
 * —— 2026-09-16 首次落地只接了栈粘贴，另两条的「按热键后内容飞到几十分钟前那个窗口」
 * 原样存在，编译、单测、构建全绿，直到人工审查才发现。
 *
 * 不带 headless 的后果链：走 `WindowBound` ⇒ 手动保存值优先 ⇒ 主窗口开着时
 * `any_own_window_visible()` 恒真 ⇒ 该值永久有效；而用户在桌面/任务栏上按热键时
 * `save_foreground_hwnd` 因 `is_valid_target` 拒绝而**保留旧值** ⇒ 用陈旧目标。
 * 带 headless 则走实时抓取，抓不到就正确取消（剪贴板不动）。
 */
describe("无窗口热键入口必须带 trigger:headless（三条清单的守卫）", () => {
  it("栈粘贴走 headless", async () => {
    const item = makeItem({ id: "h1", text: "栈顶" });
    resetStore([item]);
    useAppStore.setState({ stackMode: true, stackItems: [item] });

    await stackPasteNext();

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "栈顶", trigger: "headless" });
  });

  it("依次粘贴走 headless", async () => {
    resetStore([makeItem({ id: "h2", text: "第一条" })]);

    await sequentialPaste();

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "第一条", trigger: "headless" });
  });

  it("索引粘贴走 headless", async () => {
    resetStore([
      makeItem({ id: "h3", text: "第一条" }),
      makeItem({ id: "h4", text: "第二条" }),
    ]);

    await indexPaste(2);

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "第二条", trigger: "headless" });
  });
});

/**
 * 🔴 栈模式下的索引粘贴必须作用于**队列**（`stackItems`），不是历史列表。
 *
 * 修复前是两个同源问题：
 * ① 旧实现无条件取 `getFilteredItems()` —— 开栈时按 Ctrl+Alt+1~9 贴的是**历史列表**
 *    第 N 条，而浮标正显示着「下一条 = 栈里的某条」，两者根本不是一个队列，
 *    用户在 Excel 里按数字键会贴出几天前的内容；
 * ② 旧实现那行还带着 `.filter(h => h.type === "text")` —— 栈里的图片/文件被**静默跳过**。
 *    所以这里必须改走 `pasteHistoryItem`（与 `stackPasteNext` 同一条类型分派链）。
 */
describe("栈模式下的索引粘贴（作用于队列而非历史列表）", () => {
  /** 进栈模式并铺好队列 */
  function enterStack(items: HistoryItem[]) {
    useAppStore.setState({
      stackMode: true,
      stackItems: items,
      stackDoneIds: new Set(),
      stackPasted: 0,
      stackLoopPaste: false,
      stackLoopRound: 1,
    });
  }

  it("贴的是栈里第 N 条，不是历史列表第 N 条", async () => {
    // 历史与栈故意不同序：若仍取 getFilteredItems()，贴出去的会是「历史第二条」
    resetStore([
      makeItem({ id: "hist-1", text: "历史第一条" }),
      makeItem({ id: "hist-2", text: "历史第二条" }),
    ]);
    enterStack([
      makeItem({ id: "s1", text: "栈第一条" }),
      makeItem({ id: "s2", text: "栈第二条" }),
    ]);

    await indexPaste(2);

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "栈第二条", trigger: "headless" });
  });

  it("贴走的条目真的从队列移除（否则剩余数不准且会重复贴）", async () => {
    resetStore([]);
    enterStack([
      makeItem({ id: "s1", text: "A" }),
      makeItem({ id: "s2", text: "B" }),
      makeItem({ id: "s3", text: "C" }),
    ]);

    await indexPaste(2);

    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["s1", "s3"]);
    expect(s.stackDoneIds.has("s2")).toBe(true);
    expect(s.stackPasted).toBe(1);
  });

  it("栈里的图片条目不再被静默跳过（旧实现按 type==='text' 过滤掉它）", async () => {
    resetStore([]);
    enterStack([makeItem({ id: "img", text: "", type: "image", content: "C:/tmp/a.png" })]);

    await indexPaste(1);

    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "paste_image")).toBe(true);
  });

  it("越界时提示的是栈的条数，不是历史记录条数", async () => {
    resetStore([
      makeItem({ id: "hist-1", text: "历史一" }),
      makeItem({ id: "hist-2", text: "历史二" }),
      makeItem({ id: "hist-3", text: "历史三" }),
    ]);
    enterStack([makeItem({ id: "s1", text: "栈一" })]);

    const messages: string[] = [];
    const onToast = (e: Event) =>
      messages.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener("app-toast", onToast);
    try {
      await indexPaste(5);
    } finally {
      window.removeEventListener("app-toast", onToast);
    }

    expect(messages.some((m) => m.includes("栈里只有 1 条"))).toBe(true);
    // 不能拿历史条数去报 —— 那会告诉用户「有 3 条」，而栈里其实只有 1 条
    expect(messages.some((m) => m.includes("文本记录"))).toBe(false);
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "paste_text")).toBe(false);
  });

  it("贴走最后一条后自动退出栈模式（与 Ctrl+Alt+P 的收尾同口径）", async () => {
    resetStore([]);
    enterStack([makeItem({ id: "only", text: "唯一一条" })]);

    await indexPaste(1);

    const s = useAppStore.getState();
    expect(s.stackMode).toBe(false);
    expect(s.stackItems).toEqual([]);
  });

  it("非栈模式下仍作用于历史列表（回归钉子：栈分支不能吃掉原路径）", async () => {
    resetStore([
      makeItem({ id: "hist-1", text: "历史第一条" }),
      makeItem({ id: "hist-2", text: "历史第二条" }),
    ]);

    await indexPaste(2);

    expect(invoke).toHaveBeenCalledWith("paste_text", { text: "历史第二条", trigger: "headless" });
  });
});
