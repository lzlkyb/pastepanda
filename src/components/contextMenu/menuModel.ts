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
  /**
   * 置灰且不可点。
   *
   * 🔴 必须是**显式字段**，不能拿「没有 `onClick`」当禁用：
   * 子菜单的父项（带 `children`）本来就没 `onClick`，那样会把它一起置灰。
   *
   * ❗ 它真的落到 `<button disabled>` 上，所以点它**菜单不会关**
   * （普通项点完会 `closeMenu()`）——那才是禁用应有的手感。
   * 以前靠「不传 `onClick`」装禁用，结果是点下去菜单关掉、什么也没发生。
   */
  disabled?: boolean;
  children?: MenuItem[];
}

/** 子菜单中**能被键盘落上**的子项在 children 里的下标。
 *  activeSubIndex 直接索引 children，所以这里返回 children 的真实下标而不是紧凑序号。
 *  没有 onClick 的子项（分组标题一类）不可交互，键盘必须跳过它们。 */
export function navigableSubIndexes(item?: MenuItem): number[] {
  const out: number[] = [];
  item?.children?.forEach((c, i) => {
    if (c.onClick && !c.disabled) out.push(i);
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
  // 禁用项不能被键盘落上：它还带着 `onClick`（只是被 `disabled` 挡住），
  // 不排除的话↓会停在一个按回车没反应的项上。
  return items.filter((item) => (item.onClick || item.children) && !item.disabled);
}
