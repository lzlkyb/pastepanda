/**
 * rcOutletStore — 会话「结果出口」条的队列（甲-②，2026-09-29）。
 *
 * 为什么是 store 而不是胶囊里的 `useState`：结果的来源有**四处**（远程改档、声音、
 * 剪贴板、文件），它们分别住在 `RcSessionCapsule` / `RcCapsuleMore` / `RcClipboardBar`
 * / `RcFileBar`，其中后两个在 `{moreOpen && …}` 的条件子树里（规则 15.2 会随面板关闭
 * 一起卸载）。任何一处持有队列，另外三处都得被它挂住——单例 store 才让「谁先说话」
 * 与「谁活着」解耦。判断（档位/时长/合并/取头）全在 `lib/rcOutlet.ts`，这里只管存与计时。
 *
 * 计时器归 store 管（module 级 Map），不是为了省一个 `useEffect`，而是组件在收起态
 * 可能被 `.capFloat` 一起 `visibility:hidden`（不卸载但语义上「不在」），而一条失败
 * 该走的时长不能因为浮条收起就暂停。
 */
import { create } from "zustand";
import { rcOutletMerge, rcOutletTtlOf, type RcOutletKind } from "@/lib/rcOutlet";

export interface RcOutletEntry {
  id: number;
  kind: RcOutletKind;
  /** 一句话说清结果（「已推送到对方」）。 */
  label: string;
  /** 可选的补充（数值、文件名）。短，出口条只有一行。 */
  detail?: string;
  /** 行内动作按钮（重试 / 打开 / 取消）。 */
  actionLabel?: string;
  onAction?: () => void;
  /**
   * 同 key 就地更新（进度类高频刷新不占新位）。
   * 带 `mergeKey` 的条目**复用已有 id**，避免每次刷新都重置停留时长。
   */
  mergeKey?: string;
  /** 覆盖默认停留时长；省略 = 按 `kind` 取档（`bad` 常驻）。 */
  ttlMs?: number;
  /**
   * `run` 档的进度（0..100）。只有出口条**自己**从文件 store 现算的那条会带——
   * 结果类条目没有进度概念。
   */
  pct?: number;
}

interface RcOutletState {
  entries: RcOutletEntry[];
  /** 入队一条结果，返回它的 id（调用方想后续 dismiss 它时用）。 */
  push: (e: Omit<RcOutletEntry, "id">) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let seq = 0;
/** id → 关闭计时器。`run`/`bad` 常驻 → 表里没有它。 */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelTimer(id: number) {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** 只有「新出现且带 ttl」的条目才排计时；就地合并复用旧 id ⇒ 旧计时照走。 */
function armTimers(prev: readonly RcOutletEntry[], next: readonly RcOutletEntry[]) {
  const alive = new Set(next.map((e) => e.id));
  for (const e of prev) if (!alive.has(e.id)) cancelTimer(e.id);
  const seen = new Set(prev.map((e) => e.id));
  for (const e of next) {
    if (seen.has(e.id) || timers.has(e.id)) continue;
    const ttl = e.ttlMs ?? rcOutletTtlOf(e.kind);
    if (ttl === undefined) continue;
    timers.set(
      e.id,
      setTimeout(() => {
        timers.delete(e.id);
        useRcOutletStore.getState().dismiss(e.id);
      }, ttl),
    );
  }
}

export const useRcOutletStore = create<RcOutletState>()((set, get) => ({
  entries: [],

  push: (spec) => {
    const prev = get().entries;
    // 同 mergeKey → 复用旧 id：进度刷新不该把「它已经显示了 3s」重新计成 0
    const reuse = spec.mergeKey
      ? prev.find((e) => e.mergeKey === spec.mergeKey)?.id
      : undefined;
    const id = reuse ?? ++seq;
    const next = rcOutletMerge(prev, { ...spec, id });
    armTimers(prev, next);
    set({ entries: next });
    return id;
  },

  dismiss: (id) => {
    cancelTimer(id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
  },

  clear: () => {
    for (const e of get().entries) cancelTimer(e.id);
    timers.clear();
    set({ entries: [] });
  },
}));

/**
 * 入队一条结果（唯一推荐入口）。
 *
 * `kind` 直接给出口档；调用方若只有 toast 语义，先过 `rcOutletKindOfToast` 翻译。
 */
export function pushRcOutlet(e: Omit<RcOutletEntry, "id">): number {
  return useRcOutletStore.getState().push(e);
}

export function dismissRcOutlet(id: number) {
  useRcOutletStore.getState().dismiss(id);
}

/** 会话结束/换会话：上一场的残留不该飘进新画面。 */
export function clearRcOutlet() {
  useRcOutletStore.getState().clear();
}
