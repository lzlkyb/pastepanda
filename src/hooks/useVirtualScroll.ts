/**
 * useVirtualScroll — Lenis 平滑滚动引擎（从 CardList.tsx 提取）
 *
 * 管理：Lenis 生命周期、isScrolling 状态、
 * handleScrollToIndex（漂移校正 + 高亮）。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import Lenis from "lenis";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { HistoryItem } from "@/stores/appStore";

// ===== 类型 =====

export interface UseVirtualScrollOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lenisRef: React.RefObject<Lenis | null>;
  items: HistoryItem[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  triggerLoadMore: () => void;
}

// ===== Hook =====

export function useVirtualScroll({
  scrollRef,
  lenisRef,
  items,
  virtualizer,
  triggerLoadMore,
}: UseVirtualScrollOptions) {
  const [isScrolling, setIsScrolling] = useState(false);

  // Lenis 需要 wrapper（固定视口）≠ content（内容元素），否则数据变化后 scrollHeight 不同步导致滚动锁死
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);

  // ── handleScroll：标记滚动中（禁用 hover Popover，120ms 无滚动后复位）──
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    setIsScrolling(true);
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      setIsScrolling(false);
    }, 120);
  }, [scrollRef]);

  // ── 卸载时清理 timer ──
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  // ── Lenis 平滑滚动引擎 ──
  // Lenis scroll 向虚拟列表转发原生滚动事件。
  useEffect(() => {
    const wrapperEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!wrapperEl || !contentEl) return;

    const lenis = new Lenis({
      wrapper: wrapperEl,
      content: contentEl,
      lerp: 0.08,
      duration: 1.2,
      orientation: "vertical",
      // #3 无障碍：OS「减少动态效果」开启时滚轮走原生滚动，不做平滑插值
      smoothWheel: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      wheelMultiplier: 0.8,
      touchMultiplier: 1,
      autoResize: true,
      prevent: (node: HTMLElement) => node.classList?.contains("dialog-backdrop"),
    });

    lenisRef.current = lenis;

    // 用可变 rafId 跟踪最新帧：递归里持续更新，cleanup 才能取消“当前”帧，
    // 否则只取消首帧、循环在卸载后永久存活（P0 资源泄漏）。
    let rafId = 0;
    function raf(time: number) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    // Lenis scroll 回调：触底加载 + 派发原生 scroll 事件给虚拟列表
    let dispatchingScroll = false;
    lenis.on("scroll", ({ scroll }: Lenis) => {
      handleScroll();
      triggerLoadMore();

      // 派发原生 scroll 事件给 @tanstack/react-virtual 的 getScrollElement 监听器
      if (dispatchingScroll) return;
      dispatchingScroll = true;
      wrapperEl.scrollTop = scroll;
      wrapperEl.dispatchEvent(new Event("scroll", { bubbles: false }));
      dispatchingScroll = false;
    });

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [scrollRef, lenisRef, triggerLoadMore, handleScroll]);

  // ── 滚动到指定卡片索引 ──
  // M26：getOffsetForIndex 综合"已挂载行的实测高度 + 未挂载行的估算"；
  //      动画结束后目标行已挂载实测，再做一次漂移校正，然后才查找 DOM 做高亮
  const handleScrollToIndex = useCallback((index: number, align: "start" | "center" | "end" | "auto" = "start") => {
    const lenis = lenisRef.current;
    const item = items[index];
    if (!item || !lenis) return;
    const offsetInfo = virtualizer.getOffsetForIndex(index, align);
    const start = offsetInfo ? offsetInfo[0] : index * 82;
    lenis.scrollTo(Math.max(0, start - 10), { lerp: 0.1, duration: 0.8 });

    window.setTimeout(() => {
      const correctedInfo = virtualizer.getOffsetForIndex(index, align);
      const corrected = correctedInfo ? correctedInfo[0] : start;
      if (Math.abs(corrected - start) > 4) {
        lenis.scrollTo(Math.max(0, corrected - 10), { immediate: true });
      }
      // 高亮闪烁（此时目标行已挂载）
      const targetEl = document.querySelector(`[data-item-id="${item.id}"]`);
      if (targetEl) {
        const card = targetEl.querySelector('[class*="card"]') as HTMLElement;
        if (card) {
          card.style.boxShadow = '0 0 0 3px var(--accent), 0 8px 24px rgba(59,130,246,0.3)';
          window.setTimeout(() => { card.style.boxShadow = ''; }, 800);
        }
      }
    }, 850);
  }, [items, virtualizer, lenisRef]);

  // ── 监听 App.tsx 键盘导航的滚动请求 ──
  useEffect(() => {
    const onScrollToItem = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) handleScrollToIndex(idx, "auto");
    };
    window.addEventListener("app-scroll-to-item", onScrollToItem);
    return () => window.removeEventListener("app-scroll-to-item", onScrollToItem);
  }, [items, handleScrollToIndex]);

  return { contentRef, isScrolling };
}
