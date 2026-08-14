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
    stackLastSplit: null,
    config: {
      ...useAppStore.getState().config,
      current_workspace: "默认",
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
});
