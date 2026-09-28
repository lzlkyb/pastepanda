import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  HistoryItem,
  STACK_MAX_ITEMS_DEFAULT,
  STACK_MAX_TIERS,
  resolveStackMaxItems,
} from "@/stores/appStore";

/** 把栈容量钉到某一档（走的是 store 里那条唯一读取路径，不是测试夹具） */
function setCap(n: number) {
  useAppStore.setState({
    config: { ...useAppStore.getState().config, stack_max_items: n },
  });
}

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
    stackEvicted: 0,
    stackEvictNoticeTick: 0,
    stackPasteAllActive: false,
    stackLastSplit: null,
    stackLoopPaste: false,
    stackLoopRound: 1,
    config: {
      ...useAppStore.getState().config,
      current_workspace: "默认",
      stack_max_items: STACK_MAX_ITEMS_DEFAULT,
      table_split_enabled: true,
      table_split_format: "raw",
      table_split_include_header: false,
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
      stackEvicted: 7,
      stackEvictNoticeTick: 1,
    });

    useAppStore.getState().setStackMode(true);
    const s = useAppStore.getState();

    expect(s.stackMode).toBe(true);
    expect(s.stackItems).toEqual([]);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackPasted).toBe(0);
    expect(s.stackCollected).toBe(0);
    // 挤出计数与「只提示一次」的信号必须一起复位，否则下一轮栈会话永远不再提醒
    expect(s.stackEvicted).toBe(0);
    expect(s.stackEvictNoticeTick).toBe(0);
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

  it("caps at the configured tier (evicts oldest from the bottom)", () => {
    setCap(50);
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
    // 挤出去掉的那几条要留下计数，横幅据此提示
    expect(s.stackEvicted).toBe(5);
  });

  it("容量读的是配置，不是写死的 50", () => {
    // 🔴 上限以前是模块级常量，横幅/拆分/模板三处各自 slice 同一个数；
    //    现在它是可配置档位，任何一处绕过 resolveStackMaxItems 都会从这里漏出去。
    setCap(200);
    useAppStore.getState().setStackMode(true);
    for (let i = 0; i < 60; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `n-${i}`, text: `t${i}` }));
    }
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(60);
    expect(s.stackEvicted).toBe(0);
    for (let i = 0; i < 200; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `m-${i}`, text: `m${i}` }));
    }
    expect(useAppStore.getState().stackItems).toHaveLength(200);
  });

  it("一次栈会话里撞上限只把提示信号抬一次", () => {
    setCap(50);
    useAppStore.getState().setStackMode(true);
    for (let i = 0; i < 60; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `e-${i}`, text: `e${i}` }));
    }
    let s = useAppStore.getState();
    expect(s.stackEvictNoticeTick).toBe(1);
    expect(s.stackEvicted).toBe(10);
    // 继续撞：计数涨，信号不再抬（横幅据此只 toast 一次）
    for (let i = 0; i < 5; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `f-${i}`, text: `f${i}` }));
    }
    s = useAppStore.getState();
    expect(s.stackEvictNoticeTick).toBe(1);
    expect(s.stackEvicted).toBe(15);
    // 退出栈模式再开：信号复位，下一轮还能再提示
    useAppStore.getState().exitStackMode();
    expect(useAppStore.getState().stackEvictNoticeTick).toBe(0);
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
// stackLoopPaste 循环轮转（A 方案）
// ============================================================
describe("stackLoopPaste 循环轮转", () => {
  /** 直接铺一条队列：`stackPush` 是**头插**，逐条 push 会得到反序，而这里的断言要的是确定顺序 */
  function seedQueue(ids: string[]) {
    useAppStore.setState({
      stackMode: true,
      stackItems: ids.map((id) => makeItem({ id, text: id })),
      stackDoneIds: new Set(),
      stackPasted: 0,
      stackCollected: ids.length,
    });
  }

  it("关闭时保持出栈语义（回归钉子：别把轮转做成无条件）", () => {
    seedQueue(["a", "b"]);
    useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["b"]);
    expect(s.stackLoopRound).toBe(1);
  });

  it("开启后贴一条不出栈，而是轮转到队尾", () => {
    seedQueue(["a", "b", "c"]);
    useAppStore.setState({ stackLoopPaste: true });

    useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();

    // 队列长度不变 —— 这正是「栈空自动退出」在循环态永远不会触发的原因
    expect(s.stackItems.map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(s.stackDoneIds.has("a")).toBe(true);
    expect(s.stackPasted).toBe(1);
    expect(s.stackLoopRound).toBe(1);
  });

  it("栈顶恒为「本轮还没贴过」的那条（浮标预览与 chip 标签依赖这个不变量）", () => {
    seedQueue(["a", "b", "c"]);
    useAppStore.setState({ stackLoopPaste: true });

    for (let i = 0; i < 2; i++) useAppStore.getState().stackMarkPasted();

    const s = useAppStore.getState();
    expect(s.stackDoneIds.has(s.stackItems[0].id)).toBe(false);
  });

  it("循环态下 stackItems 与 doneIds 有交集 —— 这是横幅待贴列表必须 filter 的理由", () => {
    seedQueue(["a", "b"]);
    useAppStore.setState({ stackLoopPaste: true });
    useAppStore.getState().stackMarkPasted();

    const loop = useAppStore.getState();
    // 贴过的 a 仍在队列里（轮转到队尾）。若不过滤就渲染，它会同时出现在待贴区与已贴区
    expect(loop.stackItems.some((it) => loop.stackDoneIds.has(it.id))).toBe(true);

    // 对照：非循环态下已贴项已出栈，两者永无交集
    useAppStore.getState().exitStackMode();
    seedQueue(["a", "b"]);
    useAppStore.getState().stackMarkPasted();
    const plain = useAppStore.getState();
    expect(plain.stackItems.some((it) => plain.stackDoneIds.has(it.id))).toBe(false);
  });

  it("整轮贴完：本轮标记清空、轮次 +1、顺序回到起始排列", () => {
    seedQueue(["a", "b", "c"]);
    useAppStore.setState({ stackLoopPaste: true });

    for (let i = 0; i < 3; i++) useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackLoopRound).toBe(2);
    // ❗ 归零（不是累计）：循环态下它表示「本轮已贴」，与 loopProgress 同源。
    //   跨轮累计会让「半路关掉循环」那一刻的脚注 `${stackPasted}/${total}`
    //   变成 10/11 这种没人能解释的数字。
    expect(s.stackPasted).toBe(0);
  });

  it("队列只有一条：贴完即进下一轮，不会卡在本轮", () => {
    seedQueue(["only"]);
    useAppStore.setState({ stackLoopPaste: true });

    useAppStore.getState().stackMarkPasted();
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["only"]);
    expect(s.stackLoopRound).toBe(2);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackPasted).toBe(0); // 同上：单条队列贴一次即一轮结束
  });

  it("用 ✕ 删掉一条已贴条目后，整轮判据仍成立（doneIds 里的死 id 不干扰）", () => {
    seedQueue(["a", "b"]);
    useAppStore.setState({ stackLoopPaste: true });

    useAppStore.getState().stackMarkPasted(); // 贴 a → [b, a]，done = {a}
    useAppStore.getState().stackRemoveItem("a"); // 删掉已贴的 a → [b]，done 里留下死 id
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(["b"]);

    useAppStore.getState().stackMarkPasted(); // 贴 b → 本轮贴空
    const s = useAppStore.getState();

    // 若判据写成 done.size === 队列长度，这里会因死 id 而错判成「还没贴完」
    expect(s.stackLoopRound).toBe(2);
    expect(s.stackDoneIds.size).toBe(0);
  });

  it("循环到一半收集了新内容：它成为下一条（本轮剩余自然 +1）", () => {
    seedQueue(["a", "b"]);
    useAppStore.setState({ stackLoopPaste: true });
    useAppStore.getState().stackMarkPasted(); // [b, a]

    useAppStore.getState().stackPush(makeItem({ id: "n", text: "new" }));
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["n", "b", "a"]);
    expect(s.stackDoneIds.has("n")).toBe(false);
  });

  it("setStackMode(true) 复位循环开关与轮次（下次开栈默认关）", () => {
    useAppStore.setState({ stackLoopPaste: true, stackLoopRound: 5, stackMode: false });
    useAppStore.getState().setStackMode(true);
    const s = useAppStore.getState();
    expect(s.stackLoopPaste).toBe(false);
    expect(s.stackLoopRound).toBe(1);
  });

  it("stackLoadTemplate 绕过 setStackMode，也必须复位循环开关（漏改点守卫）", () => {
    useAppStore.setState({ stackLoopPaste: true, stackLoopRound: 4, stackMode: false });
    useAppStore.getState().stackLoadTemplate([{ type: "text", text: "t", content: "" }]);
    const s = useAppStore.getState();
    expect(s.stackMode).toBe(true);
    expect(s.stackLoopPaste).toBe(false);
    expect(s.stackLoopRound).toBe(1);
  });

  it("toggleStackLoopPaste 切换开关时轮次归 1（不继承上一次循环的轮次）", () => {
    useAppStore.setState({ stackLoopPaste: false, stackLoopRound: 7, stackMode: true });
    useAppStore.getState().toggleStackLoopPaste();
    const s = useAppStore.getState();
    expect(s.stackLoopPaste).toBe(true);
    expect(s.stackLoopRound).toBe(1);
  });

  it("🔴 半路关闭循环：本轮已贴的条目必须出栈，否则会被再贴一遍", () => {
    seedQueue(["a", "b", "c"]);
    useAppStore.setState({ stackLoopPaste: true });

    useAppStore.getState().stackMarkPasted(); // 贴 a → 轮转成 [b,c,a]
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(["b", "c", "a"]);

    useAppStore.getState().toggleStackLoopPaste(); // 关掉循环
    const s = useAppStore.getState();

    // 关掉后回到「贴一条少一条」：a 已经贴过，就不该再留在队列里
    expect(s.stackLoopPaste).toBe(false);
    expect(s.stackItems.map((i) => i.id)).toEqual(["b", "c"]);
    expect(s.stackDoneIds.size).toBe(0);
    // 待贴集合 == 队列长度。曾经是 3 vs 2：横幅说「剩余 3 条」而 toast 说「剩余 2 条」
    expect(s.stackItems.filter((it) => !s.stackDoneIds.has(it.id)).length).toBe(s.stackItems.length);

    // 贴完 b、c 即出栈清空 —— 修复前这里会多出一次 a
    useAppStore.getState().stackMarkPasted();
    useAppStore.getState().stackMarkPasted();
    expect(useAppStore.getState().stackItems).toEqual([]);
  });

  it("半路关闭循环：进度分母不虚高（stackPasted 是「本轮」口径，不是跨轮累计）", () => {
    seedQueue(["a", "b"]);
    useAppStore.setState({ stackLoopPaste: true });
    // 贴满第 1 轮，再贴第 2 轮的第 1 条
    for (let i = 0; i < 3; i++) useAppStore.getState().stackMarkPasted();
    expect(useAppStore.getState().stackLoopRound).toBe(2);
    expect(useAppStore.getState().stackPasted).toBe(1);

    useAppStore.getState().toggleStackLoopPaste();
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["b"]); // 第 2 轮已贴的 a 出栈
    // 跨轮累计（=3）时这里会得到 max(2, 4)=4 → 脚注「3/4 已粘贴」
    expect(Math.max(s.stackCollected, s.stackPasted + s.stackItems.length)).toBe(2);
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
      stackLoopPaste: true,
      stackLoopRound: 3,
    });

    useAppStore.getState().exitStackMode();
    const s = useAppStore.getState();

    expect(s.stackMode).toBe(false);
    expect(s.stackItems).toEqual([]);
    expect(s.stackDoneIds.size).toBe(0);
    expect(s.stackPasted).toBe(0);
    expect(s.stackCollected).toBe(0);
    expect(s.stackPasteAllActive).toBe(false);
    // 关栈即复位循环态：与 setStackMode(true) 两端都清，「下次打开默认关」的双保险
    expect(s.stackLoopPaste).toBe(false);
    expect(s.stackLoopRound).toBe(1);
  });

  it("is safe to call when already inactive", () => {
    useAppStore.getState().exitStackMode();
    const s = useAppStore.getState();
    expect(s.stackMode).toBe(false);
    expect(s.stackItems).toEqual([]);
  });
});

// ============================================================
// stackReorder（P1 拖拽重排：复用 quickOrder.ts 的 reorderAction）
// ============================================================
describe("stackReorder", () => {
  it("is a no-op when stackMode is false", () => {
    useAppStore.setState({
      stackItems: [makeItem({ id: "a", text: "1" }), makeItem({ id: "b", text: "2" })],
    });
    useAppStore.getState().stackReorder("a", "b");
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("moves fromId to toId's position among stackItems", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackPush(makeItem({ id: "c", text: "3" }));
    // stackItems 现在是 [c, b, a]（stackPush 头插）
    useAppStore.getState().stackReorder("a", "c"); // 把 a 拖到 c 的位置（最前）
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op when fromId/toId not found or identical", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    const before = useAppStore.getState().stackItems.map((i) => i.id);

    useAppStore.getState().stackReorder("a", "a");
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(before);

    useAppStore.getState().stackReorder("missing", "a");
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(before);

    useAppStore.getState().stackReorder("a", "missing");
    expect(useAppStore.getState().stackItems.map((i) => i.id)).toEqual(before);
  });

  it("does not touch stackDoneIds/stackPasted (already-pasted items are untouched)", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackPush(makeItem({ id: "c", text: "3" }));
    useAppStore.getState().stackMarkPasted(); // pops c → done
    useAppStore.getState().stackReorder("b", "a"); // reorder among remaining [b, a]
    const s = useAppStore.getState();
    expect(s.stackDoneIds.has("c")).toBe(true);
    expect(s.stackPasted).toBe(1);
    expect(s.stackItems.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

// ============================================================
// stackRemoveItem（P1 拖拽行悬浮删除角标）
// ============================================================
describe("stackRemoveItem", () => {
  it("is a no-op when stackMode is false", () => {
    useAppStore.setState({ stackItems: [makeItem({ id: "a", text: "1" })] });
    useAppStore.getState().stackRemoveItem("a");
    expect(useAppStore.getState().stackItems).toHaveLength(1);
  });

  it("removes the item with matching id from stackItems", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackPush(makeItem({ id: "c", text: "3" }));
    // stackItems = [c, b, a]
    useAppStore.getState().stackRemoveItem("b");
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["c", "a"]);
  });

  it("is a no-op when id is not found", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackRemoveItem("missing");
    expect(useAppStore.getState().stackItems).toHaveLength(1);
  });

  it("does not affect stackCollected/stackDoneIds/stackPasted", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackMarkPasted(); // pops b -> done
    useAppStore.getState().stackRemoveItem("a");
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(0);
    expect(s.stackCollected).toBe(2);
    expect(s.stackPasted).toBe(1);
    expect(s.stackDoneIds.has("b")).toBe(true);
  });
});

// ============================================================
// toggleStackTabAdvance（P3 粘贴+Tab 推进开关）
// ============================================================
describe("toggleStackTabAdvance", () => {
  it("默认为 false", () => {
    expect(useAppStore.getState().stackTabAdvance).toBe(false);
  });

  it("每次调用取反", () => {
    useAppStore.setState({ stackTabAdvance: false });
    useAppStore.getState().toggleStackTabAdvance();
    expect(useAppStore.getState().stackTabAdvance).toBe(true);
    useAppStore.getState().toggleStackTabAdvance();
    expect(useAppStore.getState().stackTabAdvance).toBe(false);
  });
});

// ============================================================
// stackLoadTemplate（P4 模板库载入）
// ============================================================
describe("stackLoadTemplate", () => {
  const TPL_ITEMS = [
    { type: "text" as const, text: "姓名：张三", content: "" },
    { type: "text" as const, text: "邮箱：zhang@qq.com", content: "" },
  ];

  it("把模板条目载入 stackItems 并自动进入栈模式", () => {
    useAppStore.getState().stackLoadTemplate(TPL_ITEMS);
    const s = useAppStore.getState();
    expect(s.stackMode).toBe(true);
    expect(s.stackItems).toHaveLength(2);
    expect(s.stackItems.map((i) => i.text)).toEqual(["姓名：张三", "邮箱：zhang@qq.com"]);
    // 每个载入项都要有自己的 id，且互不相同
    const ids = s.stackItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("替换（不是追加）当前未粘贴的 stackItems", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "old", text: "旧条目" }));
    useAppStore.getState().stackLoadTemplate(TPL_ITEMS);
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.text)).toEqual(["姓名：张三", "邮箱：zhang@qq.com"]);
  });

  it("保留已有的 stackDoneIds/stackPasted（不重置）", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackMarkPasted(); // 已粘贴 a
    useAppStore.getState().stackLoadTemplate(TPL_ITEMS);
    const s = useAppStore.getState();
    expect(s.stackDoneIds.has("a")).toBe(true);
    expect(s.stackPasted).toBe(1);
  });

  it("stackCollected 累加载入数量（不重置）", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" })); // stackCollected=1
    useAppStore.getState().stackLoadTemplate(TPL_ITEMS); // +2
    expect(useAppStore.getState().stackCollected).toBe(3);
  });
});

// ============================================================
// stackPushOrSplit / stackUndoSplit（表格拆分入栈，方案 A）
// ============================================================
describe("stackPushOrSplit", () => {
  it("检测到表格 → 按行拆分逐条入栈，返回拆分条数与真实总行数", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({
      id: "raw",
      text: "姓名\t邮箱\n张三\tzhang@qq.com\n李四\tli@qq.com",
    });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toEqual({ splitCount: 2, totalRows: 2 });
    const s = useAppStore.getState();
    // 拆分行顺序必须与表格原始顺序一致（张三在上），不能因为 stackPush 头插而变成倒序
    expect(s.stackItems.map((i) => i.text)).toEqual(["张三\tzhang@qq.com", "李四\tli@qq.com"]);
    expect(s.stackCollected).toBe(2);
  });

  it("相邻两行内容完全相同时也全部保留，不被 stackPush 的同顶去重吸掉", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "raw", text: "姓名\t城市\n张三\t北京\n张三\t北京" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toEqual({ splitCount: 2, totalRows: 2 });
    expect(useAppStore.getState().stackItems).toHaveLength(2);
  });

  it("非表格文本 → 按普通 item 整条入栈，返回 null", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "a", text: "普通一段文字" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toBeNull();
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].text).toBe("普通一段文字");
  });

  it("非文本类型（图片/文件）不检测表格，直接整条入栈", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "img", text: "[图片]", type: "image", content: "C:\\a.png" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toBeNull();
    expect(useAppStore.getState().stackItems).toHaveLength(1);
  });

  it("非栈模式下是空操作", () => {
    const item = makeItem({ id: "a", text: "姓名\t邮箱\n张三\tzhang@qq.com" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toBeNull();
    expect(useAppStore.getState().stackItems).toHaveLength(0);
  });

  it("table_split_enabled 关闭时不拆分，整条入栈", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.setState((s) => ({ config: { ...s.config, table_split_enabled: false } }));
    const item = makeItem({ id: "raw", text: "姓名\t邮箱\n张三\tzhang@qq.com\n李四\tli@qq.com" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toBeNull();
    expect(useAppStore.getState().stackItems).toHaveLength(1);
  });

  it("按配置的 format/includeHeader 拆分", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.setState((s) => ({
      config: { ...s.config, table_split_format: "field-value", table_split_include_header: true },
    }));
    const item = makeItem({ id: "raw", text: "姓名\t城市\n张三\t北京" });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toEqual({ splitCount: 2, totalRows: 1 });
    // 表头在文档中本来就在第一行，顺序保持一致
    expect(useAppStore.getState().stackItems.map((i) => i.text)).toEqual(["姓名\t城市", "姓名: 张三; 城市: 北京"]);
  });
});

describe("stackUndoSplit", () => {
  it("撤销最近一次拆分：移除拆出的条目，还原成一条原文", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "raw", text: "姓名\t邮箱\n张三\tzhang@qq.com\n李四\tli@qq.com" });
    useAppStore.getState().stackPushOrSplit(item);
    useAppStore.getState().stackUndoSplit();
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].text).toBe(item.text);
  });

  it("部分拆分行已粘贴后，撤销变为空操作（避免已贴部分被重复粘贴，与 stackMarkPasted 清空 stackLastSplit 的行为一致）", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "raw", text: "姓名\t城市\n张三\t北京\n李四\t上海" });
    useAppStore.getState().stackPushOrSplit(item);
    useAppStore.getState().stackMarkPasted(); // 贴掉头一行后 stackLastSplit 已被清空
    useAppStore.getState().stackUndoSplit();
    const s = useAppStore.getState();
    expect(s.stackDoneIds.size).toBe(1);
    // 撤销无效，队列保持不变，不会把已粘贴的那一行重新掩盖进一份完整原文
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackItems[0].text).toBe("李四\t上海");
  });

  it("没有可撤销的拆分记录时是空操作", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackUndoSplit();
    expect(useAppStore.getState().stackItems).toHaveLength(0);
  });
});

// ============================================================
// stackMarkPasted 与 stackLastSplit 的交互（防止部分粘贴后撤销造成重复粘贴）
// ============================================================
describe("stackMarkPasted 对 stackLastSplit 的影响", () => {
  it("贴了属于最近一次拆分的行后，撤销拆分记录被清空（避免部分粘贴后撤销造成重复粘贴）", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "raw", text: "姓名\t城市\n张三\t北京\n李四\t上海" });
    useAppStore.getState().stackPushOrSplit(item);
    expect(useAppStore.getState().stackLastSplit).not.toBeNull();
    useAppStore.getState().stackMarkPasted(); // 贴掉栈顶（张三，拆分来的）
    expect(useAppStore.getState().stackLastSplit).toBeNull();
  });

  it("贴的不是拆分来的行时，撤销拆分记录不受影响", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({ id: "raw", text: "姓名\t城市\n张三\t北京\n李四\t上海" });
    useAppStore.getState().stackPushOrSplit(item);
    useAppStore.getState().stackPush(makeItem({ id: "other", text: "另一条" }));
    // stackItems 现在 [other, 张三, 李四]
    useAppStore.getState().stackMarkPasted(); // 贴掉 other，不是拆分来的
    expect(useAppStore.getState().stackLastSplit).not.toBeNull();
  });
});

// ============================================================
// stackConsumeMerged（合并粘贴消费掉参与合并的条目，避免重复粘贴）
// ============================================================
describe("stackConsumeMerged", () => {
  it("移除指定 id 的条目并标记为已粘贴", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackPush(makeItem({ id: "b", text: "2" }));
    useAppStore.getState().stackPush(makeItem({ id: "c", text: "3" }));
    // stackItems 现在 [c, b, a]
    useAppStore.getState().stackConsumeMerged(["a", "b"]);
    const s = useAppStore.getState();
    expect(s.stackItems.map((i) => i.id)).toEqual(["c"]);
    expect(s.stackDoneIds.has("a")).toBe(true);
    expect(s.stackDoneIds.has("b")).toBe(true);
    expect(s.stackPasted).toBe(2);
  });

  it("传入不存在的 id 是空操作", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPush(makeItem({ id: "a", text: "1" }));
    useAppStore.getState().stackConsumeMerged(["missing"]);
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(1);
    expect(s.stackPasted).toBe(0);
  });

  // 🔴 主因回归：Excel / 网页表格复制的类型是 `doc`（CF_HTML 带 `<table>` 是
  //    `detect_doc_fragment` 的强信号，而 `doc_capture` 默认开）。以前类型闸门
  //    只放 text/rich，于是最常见的表格来源恰恰拆不了——这就是用户报的
  //    「有时候按表格拆分不了」。
  it("doc 类型（Excel / 网页表格复制）也要拆分", () => {
    useAppStore.getState().setStackMode(true);
    const item = makeItem({
      id: "doc",
      type: "doc",
      text: "姓名\t邮箱\n张三\tzhang@qq.com\n李四\tli@qq.com",
    });
    const result = useAppStore.getState().stackPushOrSplit(item);
    expect(result).toEqual({ splitCount: 2, totalRows: 2 });
    expect(useAppStore.getState().stackItems.map((i) => i.text)).toEqual([
      "张三\tzhang@qq.com",
      "李四\tli@qq.com",
    ]);
  });

  it("栈里已有的条目不能被拆分结果顶掉，只按剩余空间放", () => {
    // 🔴 以前是 `[...新, ...旧].slice(0, 50)`：实测栈内 40 条 + 拆一张 60 行的表
    //    = 40 条旧条目全没了，而提示只说「仅前 50 条入栈」。
    //    ❗ 得用 setState 直接置栈：`setStackMode(true)` 会把 stackItems 清空。
    //    ❗ 容量钉到 50：这条测的是「按剩余空间放」，默认档 500 的话 60 行全塞得下。
    setCap(50);
    const older: HistoryItem[] = Array.from({ length: 40 }, (_, i) =>
      makeItem({ id: `old-${i}`, text: `旧条目${i}` }),
    );
    useAppStore.setState({ stackMode: true, stackItems: older, stackCollected: 40 });
    const big = "列A\t列B\n" + Array.from({ length: 60 }, (_, i) => `r${i}\tv${i}`).join("\n");
    const result = useAppStore.getState().stackPushOrSplit(makeItem({ id: "big", text: big }));
    expect(result).toEqual({ splitCount: 10, totalRows: 60 });
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(50);
    expect(s.stackItems.filter((i) => i.id.startsWith("old-"))).toHaveLength(40);
  });

  it("栈已满时拆分不动栈，返回 splitCount 0 让调用方去提示", () => {
    setCap(50);
    const full: HistoryItem[] = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: `old-${i}`, text: `旧条目${i}` }),
    );
    useAppStore.setState({ stackMode: true, stackItems: full, stackCollected: 50 });
    const result = useAppStore
      .getState()
      .stackPushOrSplit(makeItem({ id: "t", text: "a\tb\n1\t2\n3\t4" }));
    expect(result).toEqual({ splitCount: 0, totalRows: 2 });
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(50);
    // 🔴 也不能退化成 stackPush 把整张表塞进去——那会顶掉一条旧条目
    expect(s.stackItems.every((i) => i.id.startsWith("old-"))).toBe(true);
    expect(s.stackLastSplit).toBeNull();
  });


  it("合并粘贴掉拆分行之后不能再撤销拆分（否则已贴过的会被再贴一次）", () => {
    // 🔴 实测：拆成 3 条后合并粘贴前两条，以前 stackLastSplit 还在，
    //    点「撤销拆分」会把**整张原表**塞回队列 → 已贴的两行被再贴一次。
    //    `stackMarkPasted` 本来有这个防护，`stackConsumeMerged` 漏了。
    useAppStore.getState().setStackMode(true);
    useAppStore
      .getState()
      .stackPushOrSplit(makeItem({ id: "raw", text: "列A\t列B\n1\ta\n2\tb\n3\tc" }));
    const ids = useAppStore.getState().stackItems.map((i) => i.id);
    useAppStore.getState().stackConsumeMerged([ids[0], ids[1]]);
    expect(useAppStore.getState().stackLastSplit).toBeNull();
    expect(useAppStore.getState().stackUndoSplit()).toBe(false);
    expect(useAppStore.getState().stackItems.map((i) => i.text)).toEqual(["3\tc"]);
  });

  it("撤销拆分：真撤了返 true，没东西可撤返 false（提示不能撒谎）", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPushOrSplit(makeItem({ id: "raw", text: "列A\t列B\n1\ta\n2\tb" }));
    expect(useAppStore.getState().stackUndoSplit()).toBe(true);
    expect(useAppStore.getState().stackUndoSplit()).toBe(false);
  });

  it("拆分行被删光后撤销返 false，且记录被清掉", () => {
    // 以前这里静默清记录就返回，而调用方无条件弹「已撤销拆分」——假成功。
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPushOrSplit(makeItem({ id: "raw", text: "列A\t列B\n1\ta\n2\tb" }));
    const ids = useAppStore.getState().stackItems.map((i) => i.id);
    ids.forEach((id) => useAppStore.getState().stackRemoveItem(id));
    expect(useAppStore.getState().stackUndoSplit()).toBe(false);
    expect(useAppStore.getState().stackLastSplit).toBeNull();
  });

  it("载入模板会清掉旧的拆分记录（否则撤销按钮亮着却什么也不做）", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPushOrSplit(makeItem({ id: "raw", text: "列A\t列B\n1\ta\n2\tb" }));
    useAppStore
      .getState()
      .stackLoadTemplate([{ type: "text", text: "模板1", content: "" }]);
    expect(useAppStore.getState().stackLastSplit).toBeNull();
    expect(useAppStore.getState().stackUndoSplit()).toBe(false);
  });

});

// ============================================================
// stackMarkPastedById（索引粘贴在栈模式下取走**指定**条目）
// ============================================================
describe("stackMarkPastedById", () => {
  it("取出指定条目并记为已贴，其余条目顺序不变", () => {
    useAppStore.setState({
      stackMode: true,
      stackItems: [
        makeItem({ id: "a", text: "A" }),
        makeItem({ id: "b", text: "B" }),
        makeItem({ id: "c", text: "C" }),
      ],
      stackDoneIds: new Set(),
      stackPasted: 0,
    });

    useAppStore.getState().stackMarkPastedById("b");
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["a", "c"]);
    expect([...s.stackDoneIds]).toEqual(["b"]);
    expect(s.stackPasted).toBe(1);
  });

  it("id 不存在时是 no-op（别误取走别的条目）", () => {
    useAppStore.setState({
      stackMode: true,
      stackItems: [makeItem({ id: "a", text: "A" })],
      stackDoneIds: new Set(),
      stackPasted: 0,
    });

    useAppStore.getState().stackMarkPastedById("nope");
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["a"]);
    expect(s.stackPasted).toBe(0);
  });

  it("🔴 循环态下是「移除」而不是「轮转到队尾」（轮转会打乱用户显式指定的位置）", () => {
    useAppStore.setState({
      stackMode: true,
      stackLoopPaste: true,
      stackLoopRound: 1,
      stackItems: [
        makeItem({ id: "a", text: "A" }),
        makeItem({ id: "b", text: "B" }),
        makeItem({ id: "c", text: "C" }),
      ],
      stackDoneIds: new Set(),
      stackPasted: 0,
    });

    useAppStore.getState().stackMarkPastedById("a");
    const s = useAppStore.getState();

    // 轮转的话会得到 [b, c, a]；移除才是 [b, c]
    expect(s.stackItems.map((i) => i.id)).toEqual(["b", "c"]);
    // 不变量：栈顶仍是本轮没贴过的那条（浮标预览 / chip 标签都靠它）
    expect(s.stackDoneIds.has(s.stackItems[0]!.id)).toBe(false);
  });

  it("循环态取走最后一条未贴的 → 整轮复位（栈顶不会变成已贴项）", () => {
    useAppStore.setState({
      stackMode: true,
      stackLoopPaste: true,
      stackLoopRound: 1,
      stackItems: [
        makeItem({ id: "a", text: "A" }),
        makeItem({ id: "b", text: "B" }),
      ],
      stackDoneIds: new Set(["a"]), // a 已贴
      stackPasted: 1,
    });

    useAppStore.getState().stackMarkPastedById("b"); // 取走最后一条未贴的
    const s = useAppStore.getState();

    expect(s.stackItems.map((i) => i.id)).toEqual(["a"]);
    expect(s.stackDoneIds.size).toBe(0); // 整轮清空 → a 回到「未贴」
    expect(s.stackLoopRound).toBe(2);
    expect(s.stackPasted).toBe(0);
  });

  it("取走的是最近一次表格拆分的行 → 撤销记录同步清理（不能整表塞回来重贴）", () => {
    useAppStore.getState().setStackMode(true);
    useAppStore.getState().stackPushOrSplit(makeItem({ id: "raw", text: "列A\t列B\n1\ta\n2\tb" }));
    const first = useAppStore.getState().stackItems[0]!;

    useAppStore.getState().stackMarkPastedById(first.id);

    const split = useAppStore.getState().stackLastSplit;
    expect(split === null || !split.itemIds.includes(first.id)).toBe(true);
  });
});

// ============================================================
// 栈容量收口（规则 11.1）：上限只能从 config 读，档位外的值一律回落
// ============================================================
describe("resolveStackMaxItems", () => {
  it("档位内的值原样通过", () => {
    STACK_MAX_TIERS.forEach((n) => expect(resolveStackMaxItems(n)).toBe(n));
  });

  it("档位外 / 缺失 / 脏值 → 回落默认，不猜用户想要什么", () => {
    // 🔴 老用户的后端里根本没有这个键（新增配置项不迁移），undefined 必须给出默认；
    //    存成字符串、0、负数、999999 都不能被当成容量拿去 slice。
    [undefined, null, "", "100", 0, -5, 42, 999, Number.NaN, {}, []].forEach((raw) => {
      expect(resolveStackMaxItems(raw)).toBe(STACK_MAX_ITEMS_DEFAULT);
    });
  });

  it("updateConfig 会把档位外的值归一（写回后 store 里不留脏值）", () => {
    useAppStore.getState().updateConfig({ stack_max_items: 999999 as unknown as number });
    expect(useAppStore.getState().config.stack_max_items).toBe(STACK_MAX_ITEMS_DEFAULT);
    useAppStore.getState().updateConfig({ stack_max_items: 100 });
    expect(useAppStore.getState().config.stack_max_items).toBe(100);
  });

  it("载入模板超额也走同一条挤出信号（替换语义丢的是模板尾部）", () => {
    setCap(50);
    useAppStore.getState().setStackMode(true);
    useAppStore
      .getState()
      .stackLoadTemplate(
        Array.from({ length: 70 }, (_, i) => ({ type: "text" as const, text: `t${i}`, content: "" })),
      );
    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(50);
    expect(s.stackEvicted).toBe(20);
    expect(s.stackEvictNoticeTick).toBe(1);
  });
});

// ============================================================
// 拆分行数天花板必须跟栈容量走（规则 11.1 的第 5 个调用点）
// ============================================================
describe("表格拆分的行数上限读的是栈容量", () => {
  // 🔴 `splitTableToRows` 里另有一个写死的 50：栈提到 500 之后，拆一张 60 行的表
  //    仍然只出 50 条，而提示说的是「栈上限 500」。新写第 N 个上限读取点时，
  //    这条用例就是拦住它的那道闸。
  const table60 =
    "列A\t列B\n" + Array.from({ length: 60 }, (_, i) => `r${i}\tv${i}`).join("\n");

  it("档位 500 → 60 行的表整张拆得下", () => {
    useAppStore.getState().setStackMode(true);
    const result = useAppStore
      .getState()
      .stackPushOrSplit(makeItem({ id: "t60", text: table60 }));
    expect(result).toEqual({ splitCount: 60, totalRows: 60 });
    expect(useAppStore.getState().stackItems).toHaveLength(60);
  });

  it("档位 50 → 仍然只出 50 条（拆分天花板跟着降，不是恒定 500）", () => {
    setCap(50);
    useAppStore.getState().setStackMode(true);
    const result = useAppStore
      .getState()
      .stackPushOrSplit(makeItem({ id: "t60", text: table60 }));
    expect(result).toEqual({ splitCount: 50, totalRows: 60 });
  });
});

describe("栈容量调小后的挤出计数", () => {
  it("500 档攒了 300 条再调回 50 档：掉多少条就说多少条（不是固定 1 条）", () => {
    // 🔴 提示文案会念这个数字。以前是「满了还在进新的就 +1」，档位一变一次掉
    //    两百多条，提示却说「最旧的 1 条已移出栈底」——错的数字比没有数字更糟。
    useAppStore.getState().setStackMode(true);
    for (let i = 0; i < 300; i++) {
      useAppStore.getState().stackPush(makeItem({ id: `c-${i}`, text: `c${i}` }));
    }
    expect(useAppStore.getState().stackEvicted).toBe(0);

    setCap(50);
    useAppStore.getState().stackPush(makeItem({ id: "after", text: "after" }));

    const s = useAppStore.getState();
    expect(s.stackItems).toHaveLength(50);
    expect(s.stackEvicted).toBe(251);
    expect(s.stackEvictNoticeTick).toBe(1);
  });
});
