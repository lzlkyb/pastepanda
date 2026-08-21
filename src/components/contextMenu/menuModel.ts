/**
 * 右键菜单的数据模型与纯导航算法。
 *
 * 不含 React、不含 DOM —— 键盘导航的边界条件（跳过非交互项、走到端点要停住）
 * 是这套菜单出过事的地方，单独放在纯函数里才好测、也好看懂。
 */

export interface MenuItem {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  /** 类型主操作（置顶高亮显示） */
  primary?: boolean;
  children?: MenuItem[];
}

/** 子菜单中**能被键盘落上**的子项在 children 里的下标。
 *  activeSubIndex 直接索引 children，所以这里返回 children 的真实下标而不是紧凑序号。
 *  没有 onClick 的子项（分组标题一类）不可交互，键盘必须跳过它们。 */
export function navigableSubIndexes(item?: MenuItem): number[] {
  const out: number[] = [];
  item?.children?.forEach((c, i) => {
    if (c.onClick) out.push(i);
  });
  return out;
}

/** 在可落点下标序列里从 current 往 step 方向走一格。
 *  越界就**停在端点**——绝不返回 null 或溢出，否则键盘会从子菜单里掉到顶层，
 *  而顶层紧邻位置可能就是「删除」。 */
export function stepSubIndex(list: number[], current: number | null, step: number): number | null {
  if (list.length === 0) return null;
  if (current === null) return step > 0 ? list[0] : list[list.length - 1];
  const at = list.indexOf(current);
  if (at < 0) return list[0];
  const next = at + step;
  if (next < 0 || next >= list.length) return current;
  return list[next];
}

/** 可被键盘落上的顶层项（分组父项也算——它能展开子菜单） */
export function flattenNavigable(items: MenuItem[]): MenuItem[] {
  return items.filter((item) => item.onClick || item.children);
}
