/**
 * quickOrder.ts — 快捷区动作拖拽排序的纯函数(v6.10)。
 *
 * 从 AiQuickBar 抽出,便于单测。两个函数均无副作用:
 * - applyQuickOrder:按 localStorage 顺序重排动作(不在记录里的排后面,内容驱动兜底)
 * - reorderAction:拖拽换位,返回新 id 顺序
 */

/** 按已保存顺序重排动作;无记录(或新动作)排后面,保持内容驱动匹配。 */
export function applyQuickOrder<T extends { id: string }>(
  actions: T[],
  savedOrder: string[],
): T[] {
  const rank = new Map(savedOrder.map((id, i) => [id, i]));
  return [...actions].sort(
    (a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999),
  );
}

/** 拖拽换位:把 from 移到 to(索引基于已排序列表)。返回新顺序 id 数组;非法输入返回 null。 */
export function reorderAction(
  ids: string[],
  from: number,
  to: number,
): string[] | null {
  if (from < 0 || from >= ids.length || from === to || to < 0 || to >= ids.length) {
    return null;
  }
  const next = [...ids];
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}
