/**
 * rcOutlet — 会话「结果出口」条的纯判断层（甲-②，2026-09-29，
 * design/远程电脑-交互审计整改-甲乙丙-设计稿.html §甲-②）。
 *
 * 为什么要有这条出口（缺陷机制，别写成「加个提示」）：⋯ 面板是 `{moreOpen && <RcCapsuleMore/>}`
 * 条件渲染（规则 15.2），面板一关，里面那四类结果（码率 / 声音 / 剪贴板 / 文件）的内联
 * 反馈**随子树一起卸载**（=C1）。更糟的一层：`onStatus` 走的是全局 toast，而 toast 容器住在
 * ToastProvider（rc-main.tsx 的树根），**不在全屏元素 `.sessionWrap` 的子树里** —— 浏览器在
 * 元素全屏时只渲染该子树，所以全屏态里这些 toast 一条都看不见（与 C2 同一个根）。
 * 出口条挂在 `.capZone` 直系（会话壳内、且父级永不 `visibility:hidden`），才真正满足
 * 规则 15.1「触发常驻可见 ⇒ 结果常驻可见」。
 *
 * 三档生命周期（本文件唯一需要判的地方，守卫单测钉住）：
 * - `ok`   ：2s 自清（成功只需要一眼，不该留在画面上）。
 * - `info` ：6s 自清，与 `useOkAutoClear` 的「成功/信息浮条 6s」同口径（规则 11.1）。
 * - `bad`  ：**常驻**直到用户 ✕ 掉或被顶掉——失败必须给第二次看见的机会（规则 15.3）。
 * - `run`  ：常驻，但只允许一条（按 `mergeKey` 就地更新，进度刷新增次数会把队列刷爆）。
 */

/** 出口条的四档生命周期。 */
export type RcOutletKind = "ok" | "info" | "bad" | "run";

/** `ok` 停留时长（稿 §甲-②「成功也报，2s 后自动收起」）。 */
export const OUTLET_OK_MS = 2000;
/** `info` 停留时长：与 `useOkAutoClear` 的 6s 同源，别在这里再造一个数。 */
export const OUTLET_INFO_MS = 6000;
/** 同屏最多攒几条（超出丢最旧的）。出口条只画一条，其余靠计数。 */
export const OUTLET_MAX = 4;

/**
 * toast 的 type → 出口条的生命周期档。
 *
 * 调用方传进来的仍是 toast 那套语义（`success`/`error`/…），这里只负责翻译成停留档，
 * 避免每个调用点各写一遍 if（规则 11.1）。未知值一律按 `info` 处理：宁可多说一句、
 * 6s 后自己走，也不要因为拼错就把一条错误永久钉在画面上。
 */
export function rcOutletKindOfToast(t: string | undefined): RcOutletKind {
  if (t === "success") return "ok";
  if (t === "error" || t === "warning") return "bad";
  return "info";
}

/** 这一档活多久；`undefined` = 不自清（等用户 ✕ 或被顶掉）。 */
export function rcOutletTtlOf(kind: RcOutletKind): number | undefined {
  if (kind === "ok") return OUTLET_OK_MS;
  if (kind === "info") return OUTLET_INFO_MS;
  return undefined;
}

/**
 * 队列插入策略（纯函数，守卫单测钉住）：返回「新数组」而不是原地改。
 *
 * - 带 `mergeKey` 且队里已有同 key → **就地替换并保留原位置**：文件进度每 100ms 推一次，
 *   若按「新的在最前」排，进度条会永远压在其它结果之上刷掉它们，且队列位置每秒重排。
 * - 否则插到最前，截到 `OUTLET_MAX`（丢最旧）。
 */
export function rcOutletMerge<T extends { id: number; mergeKey?: string }>(
  prev: readonly T[],
  next: T,
  max: number = OUTLET_MAX,
): T[] {
  if (!next.mergeKey) return [next, ...prev.filter((e) => e.id !== next.id)].slice(0, max);
  const at = prev.findIndex((e) => e.mergeKey === next.mergeKey);
  if (at < 0) return [next, ...prev].slice(0, max);
  const out = prev.slice();
  out[at] = next;
  return out;
}

/**
 * 该展示哪一条：同刻只显示最新一条 + 计数（稿 §甲-②）。
 *
 * 排序不按时间，按**该被看见的紧迫度**：`bad`（要你处理）> `run`（正在进行）>
 * `info` > `ok`。理由：一条 2s 就走的「已推送」不该把「重连失败」挤出画面；
 * 反过来「传文件 2/3」盖在成功提示上是合理的，因为进度会自己走完。
 * 同档内保持队列原有顺序（＝新的在前）。
 */
export function rcOutletHead<T extends { kind: RcOutletKind }>(
  entries: readonly T[],
): { head: T | null; rest: number } {
  if (!entries.length) return { head: null, rest: 0 };
  const order: RcOutletKind[] = ["bad", "run", "info", "ok"];
  for (const k of order) {
    const at = entries.findIndex((e) => e.kind === k);
    if (at >= 0) return { head: entries[at], rest: entries.length - 1 };
  }
  return { head: entries[0], rest: entries.length - 1 };
}
