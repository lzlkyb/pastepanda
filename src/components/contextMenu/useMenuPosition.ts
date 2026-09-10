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
  /** `pos.x` 是菜单的**右缘**而不是左缘（从按钮点开的下拉）。 */
  alignRight?: boolean;
}) {
  const { open, pos, items, activeIndex, alignRight } = params;
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
    //
    // 🔴 `alignRight` 跳过这套“碰巧”逻辑：它把 `pos.x` 当右缘，
    //    无论空间够不够都与触发按钮右缘对齐。没它的时候，顶栏右上角那个
    //    「⋯」会出现两种都错开的情形：空间够→菜单往右穿到设置/窗口按钮底下；
    //    空间不够→翻成「菜单右缘贴按钮**左**缘」，与按钮错开一个按钮宽。
    //    下面的视口钳制仍然生效，所以不会因此跑出屏幕。
    let left = alignRight ? pos.x - menuW : pos.x;
    if (!alignRight && availRight < menuW && availLeft > availRight) {
      left = pos.x - menuW;
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - menuW - MARGIN));

    // 垂直方向：优先向下，空间不足时向上
    let top = pos.y;
    if (availBelow < menuH && availAbove > availBelow) {
      top = pos.y - menuH;
    }
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - menuH - MARGIN));

    /**
     * 入场缩放的原点 —— 菜单**贴着锚点的那个角**。
     *
     * 🔴 不能写死 `top left`，也不能只按 `alignRight` 二选一：上面两段翻折会把
     * 菜单翻到锚点的左边 / 上边，之后的视口钳制还可能让它落到第三个位置。
     * 写死的后果是贴着屏幕右下角右键时，菜单从**离鼠标最远**的那个角长出来，
     * 看起来像是从别处飞过来的。
     *
     * 所以按最终坐标反推：右缘落在锚点上 ⇒ 从右边长；下缘落在锚点上 ⇒ 从下边长。
     * 1px 容差是因为 `left` / `top` 经过钳制后可能带小数。
     */
    const originX = left + menuW <= pos.x + 1 ? "right" : "left";
    const originY = top + menuH <= pos.y + 1 ? "bottom" : "top";

    return { left, top, origin: `${originY} ${originX}` };
  // 依赖里必须带 `alignRight`：不带也“能跑”（`trigger` 每次 `setPos({x,y})`
  // 都是新对象，会连带重算），但那是撑在一个无关的引用等式上。
  }, [pos, menuSize, alignRight]);

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
