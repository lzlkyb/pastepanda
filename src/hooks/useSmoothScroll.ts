/**
 * useSmoothScroll —— 给一个普通滚动容器接上 Lenis 平滑滚动。
 *
 * # 为何不直接用 `useVirtualScroll`
 *
 * 那个 hook 里的 Lenis 与 **虚拟列表**绑在一起（measureElement、
 * scrollMetrics 同步给 Timeline、按 index 滚定位……），而知识列表没有虚拟列表。
 * 硬拆那个 hook 会把记录模式的滚动也一起搅进来，不值得。
 *
 * # 为何不担心「两个 Lenis 两个 rAF 循环」
 *
 * `App.tsx` 里三个模式是 **互斥挂载**的（`{appMode === "record" && …}`），
 * 切到知识模式时 CardList 整个卸载、它的 Lenis 跟着销毁。
 * 同一时刻只存在一个实例。
 *
 * # 为何需要两个 ref
 *
 * Lenis 要 `wrapper`（滚动容器）+ `content`（内层）**两个嵌套元素**。
 * `content` 是给它量内容高度用的（内部挂 `contentResizeObserver` 算滚动上限），
 * **不是**用来做位移的：1.3.25 的 dist 里 `transform` 零出现，它走原生 `scrollTop`。
 * （正因为如此，吸顶组头、IntersectionObserver、以及滚动容器内的定位都照旧起作用。）
 */
import { useEffect, useRef, type RefObject } from "react";
import Lenis from "lenis";

export function useSmoothScroll(
  wrapperRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): RefObject<Lenis | null> {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const lenis = new Lenis({
      wrapper,
      content,
      // 参数与 `useVirtualScroll` 一致。另调一套就是「两个模式滚动手感不同」
      // 的另一种形式——而那正是接它进来要解决的问题。
      lerp: 0.08,
      duration: 1.2,
      orientation: "vertical",
      // 无障碍：OS「减少动态效果」开着时滚轮走原生滚动，不做平滑插值。
      // （globals.css 的全局兜底只管 CSS 动画，管不到 JS 插值。）
      smoothWheel: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      wheelMultiplier: 0.8,
      touchMultiplier: 1,
      autoResize: true,
    });
    lenisRef.current = lenis;

    // 可变 rafId：递归里持续更新，cleanup 才能取消「当前」帧。
    // 只 cancel 首帧的写法会让循环在卸载后永久存活（同 useVirtualScroll 里那条注释）。
    let rafId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [wrapperRef, contentRef]);

  return lenisRef;
}
