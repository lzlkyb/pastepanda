/**
 * 循环粘贴的**本轮进度**计算 —— 横幅（`StackBanner`）与粘贴 API（`lib/api/stack.ts`）
 * 两处共用同一份账。
 *
 * ## 为什么必须收口
 *
 * 「本轮已贴几条」有两处会各算一遍：横幅脚注（显示用）与 `stackPasteNext`
 * （toast / 浮标用）。两处各写一份 filter，早晚会漂移出「横幅说还剩 2 条、
 * 浮标说还剩 3 条」。这个项目的浮标与横幅**已经是**同一份进度账
 * （见 `hudBridge.progressFromStore` 的注释），别在这里破例。
 *
 * ## 为什么按 `doneIds` 反查而不是另开一个计数器
 *
 * 计数器在「用户用 ✕ 删掉一条已贴的」时会与队列脱节：队列少了一条，计数器
 * 不知道。按 `doneIds` 现算则天然自洽 —— 删掉的 id 不在队列里，就不参与计数。
 * 代价是每次 O(n)，而 n ≤ `STACK_MAX_ITEMS`（50），可忽略。
 *
 * 泛型 + 结构约束（只要求 `id`）而非 import `HistoryItem`：本文件不该依赖
 * appStore 的类型图，保持可被任意侧 import。
 */

export interface LoopProgress {
  /** 本轮已贴条数（仅统计**仍在队列里**的） */
  done: number;
  /** 本轮分母：队列总条数 */
  total: number;
  /** 本轮还没贴过的条数 */
  remaining: number;
}

/**
 * 算本轮进度。
 *
 * ❗ 非循环态同样传进来也能得到正确结果：那时已贴条目已经**出栈**，
 *   `doneIds` 里的 id 一个都不在 `items` 里，于是 `done = 0`、
 *   `remaining = total = 队列长度` —— 正是非循环态想要的「剩余 = 队列长度」。
 *   所以调用点不必分叉，统一调这一个函数。
 */
export function loopProgress<T extends { id: string }>(
  items: readonly T[],
  doneIds: ReadonlySet<string>,
): LoopProgress {
  let done = 0;
  for (const it of items) {
    if (doneIds.has(it.id)) done += 1;
  }
  return { done, total: items.length, remaining: items.length - done };
}
