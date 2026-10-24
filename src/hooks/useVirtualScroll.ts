/**
 * useVirtualScroll — Lenis 平滑滚动引擎（从 CardList.tsx 提取）
 *
 * 管理：Lenis 生命周期、isScrolling 状态、
 * handleScrollToIndex（漂移校正 + 键盘焦点）。

 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import Lenis from "lenis";
import { isModalScrollLocked } from "@/contexts/ScrollContext";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { HistoryItem } from "@/stores/appStore";

// ===== 类型 =====

export interface UseVirtualScrollOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lenisRef: React.RefObject<Lenis | null>;
  items: HistoryItem[];
  focusId: string | null;
  virtualizer: Virtualizer<HTMLDivElement, Element>;

  triggerLoadMore: () => void;
}

// ===== Hook =====

export function useVirtualScroll({
  scrollRef,
  lenisRef,
  items,
  focusId,
  virtualizer,

  triggerLoadMore,
}: UseVirtualScrollOptions) {

  const [isScrolling, setIsScrolling] = useState(false);

  // Lenis 需要 wrapper（固定视口）≠ content（内容元素），否则数据变化后 scrollHeight 不同步导致滚动锁死
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const correctionTimer = useRef<number | null>(null);
  const pendingFocus = useRef<{ id: string; origin: Element | null } | null>(null);
  const latestItems = useRef(items);
  latestItems.current = items;

  const focusPendingCard = useCallback(() => {
    const request = pendingFocus.current;
    if (!request) return;
    // 虚拟行等待挂载期间，用户若已转去输入/操作别处，就不再抢回焦点。
    if (document.activeElement !== request.origin && document.activeElement !== document.body) {
      pendingFocus.current = null;
      return;
    }
    const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])]
      .find(el => el.dataset.itemId === request.id);
    const card = row?.querySelector<HTMLElement>('[role="option"]');
    if (card) {
      pendingFocus.current = null;
      card.focus({ preventScroll: true });
    }
  }, [scrollRef]);

  // 目标可能尚未挂载；每次虚拟列表提交后只检查一个待聚焦目标，不启动轮询。
  useLayoutEffect(() => {
    if (pendingFocus.current && pendingFocus.current.id !== focusId) pendingFocus.current = null;
    const wrapper = scrollRef.current;
    if (!focusId && wrapper?.contains(document.activeElement) && document.activeElement?.closest('[role="option"]')) {
      wrapper.focus({ preventScroll: true });
    }
    focusPendingCard();
  });

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
      if (correctionTimer.current !== null) window.clearTimeout(correctionTimer.current);
      pendingFocus.current = null;
    };
  }, []);

  // ── Lenis 平滑滚动引擎 ──
  // Lenis scroll only forwards the native scroll event to the virtualizer.
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
    // 🔴 批次③：同 useSmoothScroll——锁先于 Lenis 存在时由创建方补锁。
    if (isModalScrollLocked()) lenis.stop();

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
  //      目标行挂载后再校正；视觉高亮只由 Card 的当前项状态控制。
  const handleScrollToIndex = useCallback((index: number, align: "start" | "center" | "end" | "auto" = "start") => {
    const lenis = lenisRef.current;
    const item = items[index];
    if (!item || !lenis) return;
    if (correctionTimer.current !== null) window.clearTimeout(correctionTimer.current);
    // auto 是连续键盘导航，立即跟随；已在视口中的项目不做额外滚动。
    const immediate = align === "auto" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const offsetInfo = virtualizer.getOffsetForIndex(index, align);
    const start = offsetInfo ? offsetInfo[0] : index * 82;
    const inset = align === "auto" ? 0 : 10;
    lenis.scrollTo(Math.max(0, start - inset), immediate ? { immediate: true } : { lerp: 0.1, duration: 0.8 });

    correctionTimer.current = window.setTimeout(() => {
      correctionTimer.current = null;
      const currentIndex = latestItems.current.findIndex(row => row.id === item.id);
      if (lenisRef.current !== lenis || currentIndex < 0) return;
      const correctedInfo = virtualizer.getOffsetForIndex(currentIndex, align);
      const corrected = correctedInfo ? correctedInfo[0] : start;
      if (Math.abs(corrected - start) > 4) {
        lenis.scrollTo(Math.max(0, corrected - inset), { immediate: true });
      }
    }, immediate ? 0 : 850);
  }, [items, virtualizer, lenisRef]);

  // ── 监听 App.tsx 键盘导航的滚动请求 ──
  useEffect(() => {
    const onScrollToItem = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) {
        pendingFocus.current = { id, origin: document.activeElement };
        handleScrollToIndex(idx, "auto");
        focusPendingCard();
      }
    };
    window.addEventListener("app-scroll-to-item", onScrollToItem);
    return () => window.removeEventListener("app-scroll-to-item", onScrollToItem);
  }, [items, handleScrollToIndex, focusPendingCard]);

  return { contentRef, isScrolling };
}
