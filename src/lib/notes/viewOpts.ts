/**
 * 字段视图的选项类型与默认值（B2 #9）。
 *
 * **默认全空串 = 与做这个功能之前一模一样**，后端那边同口径
 * （`note_list` 保留原签名、转调 `note_list_view` 传 default）。
 * 所以“不动任何控件时行为不变”是结构保证的，不靠测试盯。
 *
 * 三态筛选用 `"" | "yes" | "no"` 而不是 `boolean | undefined`：
 * 与 chip 的三态一一对应，也与后端的反序列化完全对应（不存在 null/false 歧义）。
 *
 * 🔴 红线：纯本地查询参数，无 AI、不联网。
 */

/** 三态筛选。`""` = 不筛。 */
export type Tri = "" | "yes" | "no";

export type NoteSort = "" | "updated" | "created" | "accessed" | "title";
export type NoteGroupBy = "" | "folder" | "month" | "tag";

export interface NoteViewOpts {
  sort: NoteSort;
  groupBy: NoteGroupBy;
  summary: Tri;
  fromCard: Tri;
  tagged: Tri;
}

export type InboxSort = "" | "signal" | "recent" | "recopy";
export type InboxGroupBy = "" | "type" | "source" | "reason";
export type InboxReason = "" | "star" | "research";

export interface InboxViewOpts {
  sort: InboxSort;
  groupBy: InboxGroupBy;
  reason: InboxReason;
  pasted: Tri;
  /** 内容类型多选（并集）。空 = 不筛。 */
  types: string[];
}

export const DEFAULT_NOTE_VIEW: NoteViewOpts = {
  sort: "",
  groupBy: "",
  summary: "",
  fromCard: "",
  tagged: "",
};

export const DEFAULT_INBOX_VIEW: InboxViewOpts = {
  sort: "",
  groupBy: "",
  reason: "",
  pasted: "",
  types: [],
};

/** 下拉选项（value 空串 = 默认项）。 */
export interface ViewOption {
  value: string;
  label: string;
  /** 摆在选项右侧的小字提醒（可选） */
  hint?: string;
}

export const NOTE_SORTS: ViewOption[] = [
  { value: "", label: "最近修改" },
  { value: "created", label: "最近创建" },
  { value: "accessed", label: "最近打开", hint: "从未打开的排最后" },
  { value: "title", label: "标题 A→Z", hint: "中文按编码序" },
];

export const NOTE_GROUPS: ViewOption[] = [
  { value: "", label: "不分组" },
  { value: "folder", label: "按文件夹" },
  { value: "month", label: "按创建月份" },
  { value: "tag", label: "按标签", hint: "多标签会重复出现" },
];

export const INBOX_SORTS: ViewOption[] = [
  { value: "", label: "信号最强" },
  { value: "recent", label: "最近采集" },
  { value: "recopy", label: "重复复制最多", hint: "刚开始累加" },
];

export const INBOX_GROUPS: ViewOption[] = [
  { value: "", label: "不分组" },
  { value: "type", label: "按内容类型" },
  { value: "source", label: "按来源应用" },
  { value: "reason", label: "按入选原因" },
];

/**
 * 这一行前面要不要插组头？要就返回组名，不要则 `null`。
 *
 * 分组本身已经在 SQL 的 `ORDER BY` 里做了，**前端只干这一件事**：
 * 相邻两行的组键不同 → 插一个组头。所以分页天然正确：
 * 滚到底拉下一页，新行要么接在当前组里（组键相同 → 不插），要么开一个新组。
 *
 * 两个面板共用（规则 #11）：写两份就会有一份忘了处理「第一行也要插组头」。
 */
export function groupHeaderFor(
  rows: { group_key?: string | null }[],
  i: number,
): string | null {
  const key = rows[i]?.group_key ?? null;
  if (key === null) return null;
  const prev = i > 0 ? (rows[i - 1]?.group_key ?? null) : null;
  return key === prev ? null : key;
}

/** 一个已生效的选项 chip。 */
export interface ViewChip {
  label: string;
  onClear: () => void;
}

function labelOf(opts: ViewOption[], value: string): string {
  return opts.find((o) => o.value === value)?.label ?? value;
}

const TRI_LABEL: Record<string, [string, string]> = {
  summary: ["有摘要", "无摘要"],
  fromCard: ["来自卡片", "手工新建"],
  tagged: ["有标签", "无标签"],
  pasted: ["粘贴过", "未粘贴过"],
};

function triChip(
  key: keyof typeof TRI_LABEL,
  v: Tri,
  clear: () => void,
): ViewChip | null {
  if (!v) return null;
  const [yes, no] = TRI_LABEL[key];
  return { label: v === "yes" ? yes : no, onClear: clear };
}

/**
 * 把当前选项算成 chips。**返回空数组 = 默认态**，调用方靠它判要不要渲染 chips 行。
 *
 * 写在这里而不是组件里：「什么算非默认」这个判断两个面板都要用，
 * 而它又决定了图标高不高亮、chips 行出不出现——写两份必定漏一个维度。
 */
export function noteViewChips(
  v: NoteViewOpts,
  set: (patch: Partial<NoteViewOpts>) => void,
): ViewChip[] {
  const out: ViewChip[] = [];
  if (v.sort) out.push({ label: labelOf(NOTE_SORTS, v.sort), onClear: () => set({ sort: "" }) });
  if (v.groupBy) {
    out.push({ label: labelOf(NOTE_GROUPS, v.groupBy), onClear: () => set({ groupBy: "" }) });
  }
  const tris: [keyof typeof TRI_LABEL, Tri, () => void][] = [
    ["summary", v.summary, () => set({ summary: "" })],
    ["fromCard", v.fromCard, () => set({ fromCard: "" })],
    ["tagged", v.tagged, () => set({ tagged: "" })],
  ];
  for (const [k, val, clear] of tris) {
    const c = triChip(k, val, clear);
    if (c) out.push(c);
  }
  return out;
}

export function inboxViewChips(
  v: InboxViewOpts,
  set: (patch: Partial<InboxViewOpts>) => void,
  typeLabel: (t: string) => string,
): ViewChip[] {
  const out: ViewChip[] = [];
  if (v.sort) out.push({ label: labelOf(INBOX_SORTS, v.sort), onClear: () => set({ sort: "" }) });
  if (v.groupBy) {
    out.push({ label: labelOf(INBOX_GROUPS, v.groupBy), onClear: () => set({ groupBy: "" }) });
  }
  if (v.reason) {
    out.push({
      label: v.reason === "star" ? "只看收藏" : "只看找回",
      onClear: () => set({ reason: "" }),
    });
  }
  const p = triChip("pasted", v.pasted, () => set({ pasted: "" }));
  if (p) out.push(p);
  for (const t of v.types) {
    out.push({
      label: typeLabel(t),
      onClear: () => set({ types: v.types.filter((x) => x !== t) }),
    });
  }
  return out;
}
