/**
 * 菜单定位：测量真实尺寸 → 贴边翻折 → 子菜单钳制。
 *
 * 之所以要实测而不是估算：菜单项数量随条目类型变化，高度差得远。以前用写死的
 * 180×260 估算 + 绘制后才测（useEffect），贴近屏幕右/下边缘时首帧会画在估算位置
 * 再跳一下。现在两处测量都是 useLayoutEffect（绘制前完成），首帧就是最终位置。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MenuItem } from "./menuModel";
import styles from "../ContextMenu.module.css";

/** 菜单与视口边缘的最小间距 */
const MARGIN = 8;

export function useMenuPosition(params: {
  open: boolean;
  pos: { x: number; y: number } | null;
  items: MenuItem[];
  activeIndex: number;
}) {
  const { open, pos, items, activeIndex } = params;
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [menuSize, setMenuSize] = useState({ width: 0, height: 0 });

  // 用 offsetWidth/offsetHeight 而不是 getBoundingClientRect：菜单入场动画带
  // scale 0.95→1，而 rect 是**变换后**的尺寸，动画期间量出来会小 5%（offsetWidth 不受
  // transform 影响）。items 的标签拼成 key 作为稳定依赖，避免每次渲染都重测。
  const itemsKey = items.map((i) => i.label + (i.children?.length ?? 0)).join("|");
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (open && el) {
      setMenuSize({ width: el.offsetWidth, height: el.offsetHeight });
    }
  }, [open, itemsKey]);

  // 智能翻折：默认右下弹出 → 空间不足时自动翻到左上。
  // 用 useMemo 而不是渲染期间 setState，避免 React error #301（无限重渲染）。
  const adjustedPos = useMemo(() => {
    // 还没量到真实尺寸就先不调整，直接用光标位置。上面的 useLayoutEffect 会在绘制前
    // 量完并触发重渲染，所以这一帧不会被用户看到 —— 也就不需要写死的估算值了。
    if (!pos || menuSize.width === 0 || menuSize.height === 0) return null;
    const menuW = menuSize.width;
    const menuH = menuSize.height;
    const availRight = window.innerWidth - pos.x - MARGIN;
    const availBelow = window.innerHeight - pos.y - MARGIN;
    const availLeft = pos.x - MARGIN;
    const availAbove = pos.y - MARGIN;

    // 水平方向：优先向右，空间不足时向左
    let left = pos.x;
    if (availRight < menuW && availLeft > availRight) {
      left = pos.x - menuW;
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - menuW - MARGIN));

    // 垂直方向：优先向下，空间不足时向上
    let top = pos.y;
    if (availBelow < menuH && availAbove > availBelow) {
      top = pos.y - menuH;
    }
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - menuH - MARGIN));

    return { left, top };
  }, [pos, menuSize]);

  // 子菜单边缘钳制：打开瞬间（挂载后、绘制前）测量真实宽高与父项视口位置——
  //   水平：按实测宽度决定向右还是向左翻转；
  //   垂直：默认锚在父项上缘 -4px，超出底边时整体上移，比可用视口还高时顶部钳制 + 内部滚动。
  // 仅当前激活父项的子菜单会挂载，submenuRef 即指向它。
  useLayoutEffect(() => {
    const sub = submenuRef.current;
    if (!sub) return;
    const parent = sub.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 先清掉上一次的行内调整再测量自然尺寸，避免 maxHeight 钳制形成反馈
    sub.style.top = "";
    sub.style.maxHeight = "";
    sub.style.overflowY = "";
    sub.classList.remove(styles.flipLeft);

    const subW = sub.offsetWidth;
    const subH = sub.offsetHeight;

    // 水平：优先向右，放不下且左侧放得下时翻到左侧
    const fitsRight = parentRect.right + 4 + subW <= vw - MARGIN;
    const fitsLeft = parentRect.left - 4 - subW >= MARGIN;
    sub.classList.toggle(styles.flipLeft, !fitsRight && fitsLeft);

    // 垂直：超出底边上移；上移后顶到上缘仍放不下，则顶部钳制 + 限高滚动
    let topOffset = -4;
    const naturalBottom = parentRect.top + topOffset + subH;
    if (naturalBottom > vh - MARGIN) {
      topOffset -= naturalBottom - (vh - MARGIN);
      if (parentRect.top + topOffset < MARGIN) {
        topOffset = MARGIN - parentRect.top;
        sub.style.maxHeight = `${vh - 2 * MARGIN}px`;
        sub.style.overflowY = "auto";
      }
    }
    sub.style.top = `${topOffset}px`;
  }, [activeIndex, pos, items]);

  return { menuRef, submenuRef, adjustedPos };
}
