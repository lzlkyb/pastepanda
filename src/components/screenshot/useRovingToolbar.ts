import { useCallback, useEffect, type RefObject, type KeyboardEvent, type FocusEvent } from "react";

/**
 * 工具栏的 roving tabindex（WAI-ARIA toolbar 模式）。
 *
 * # 为什么必须有
 *
 * 上一步把截图窗里的 `<span onClick>` / `<div onClick>` 全换成了真 `<button>`，
 * 并给两条栏加了 `role="toolbar"`。但 `role="toolbar"` 是一句**承诺**：
 * 屏阅读器会告诉用户「这是工具栏」，而用户据此预期的是
 * **一个 Tab 位 + 组内方向键**。只标 role 不做漫游焦点，比不标 role 更坏——
 * 它把一个错的导航模型告诉了用户。
 *
 * 现实代价也在这里：属性条展开时有二十多个按钮（九个色点 + 四档粗细 + ……），
 * 逐个 Tab 过去要敲二十多下才能走到「完成」。
 *
 * # 🔴 必须 stopPropagation
 *
 * ScreenshotOverlay 在 **window** 上绑了方向键（select 态微调选区、annotate 态挪标注）。
 * 只调 preventDefault 不够：事件照样冒泡到 window，按一下右键会
 * 「焦点右移」+「选区右移 1px」同时发生。
 * 反过来，**不属于本栏的键一律放行**（字母快捷键 R/T/Esc/Enter ……都靠那个
 * window 监听器干活），所以这里只拦真的处理了的那几个键。
 *
 * # 禁用项也要能走到
 *
 * 工具栏里的禁用项用的是 `aria-disabled` 而不是原生 `disabled`（见 AnnotToolbar 注释），
 * 所以它们仍在漫游序里——APG 的口径也是如此：跳过禁用项会让人无从知道
 * “还有这么一个功能、只是现在不能用”。
 */
export function useRovingToolbar(ref: RefObject<HTMLElement | null>) {
  /** 按 DOM 顺序取本栏的可聚焦项。不过滤 aria-disabled（见模块注释）。 */
  const itemsOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>("button"));

  // 每次渲染后重新收口：属性条的分组会随工具切换**整组**出现/消失，
  // 上一次那个 tabIndex=0 的按钮可能已经不在 DOM 里了——那时整条栏就一个
  // Tab 位也没有，变成“整栏又进不去了”。没写依赖数组是故意的。
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = itemsOf(root);
    if (items.length === 0) return;
    // 🔴 必须读 attribute 而不是 `el.tabIndex`：<button> 没写 tabindex 时
    // `el.tabIndex` 也返 **0**，于是「已经有落点了」永远为真、整个收口空转，
    // 二十多个按钮全留在 Tab 序里（写成 el.tabIndex === 0 时实测 11 个都可 Tab）。
    const explicit = items.filter((el) => el.getAttribute("tabindex") === "0");
    // 已有唯一落点就别动它，只把其余（含新挂载、还没写过 tabindex 的）收成 -1；
    // 否则每次重渲染都把落点弹回第一个，用户刚走到第十个、一选中就被拉回去了。
    if (explicit.length === 1) {
      for (const el of items) if (el !== explicit[0]) el.tabIndex = -1;
      return;
    }
    // 首次落点（或上一个落点已随分组卸载）：优先当前选中项（aria-pressed），否则第一个。
    const active = items.find((el) => el.getAttribute("aria-pressed") === "true") ?? items[0];
    for (const el of items) el.tabIndex = el === active ? 0 : -1;
  });

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (
      e.key !== "ArrowLeft" && e.key !== "ArrowRight" &&
      e.key !== "ArrowUp" && e.key !== "ArrowDown" &&
      e.key !== "Home" && e.key !== "End"
    ) return;
    const root = e.currentTarget;
    const items = itemsOf(root);
    const cur = items.indexOf(document.activeElement as HTMLElement);
    // 焦点不在本栏里（比如人在画布上）就不抢——那时方向键归选区/标注。
    if (cur === -1) return;
    e.preventDefault();
    e.stopPropagation(); // 🔴 见模块注释：window 上还绑着方向键
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : (cur + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[cur].tabIndex = -1;
    items[next].tabIndex = 0;
    items[next].focus();
  }, []);

  // 鼠标点一下之后，Tab 应该从刚点的那个接着走，而不是回到栏首。
  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    const root = e.currentTarget;
    const target = e.target as HTMLElement;
    if (target.tagName !== "BUTTON" || !root.contains(target)) return;
    for (const el of itemsOf(root)) el.tabIndex = el === target ? 0 : -1;
  }, []);

  return { onKeyDown, onFocus };
}
