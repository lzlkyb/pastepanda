/**
 * useVirtualScroll — Lenis 平滑滚动引擎 + 时间轴指标（从 CardList.tsx 提取）
 *
 * 管理：Lenis 生命周期、scrollMetrics 同步、isScrolling 状态、
 * handleScrollToIndex（漂移校正 + 高亮）、时间轴节点/分组计算、
 * Timeline 滚轮/拖拽滚动。
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Lenis from "lenis";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { HistoryItem } from "@/stores/appStore";
import type { TimeGroup, TimelineNode } from "@/components/Timeline";

// ===== 类型 =====

export interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

export interface UseVirtualScrollOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lenisRef: React.RefObject<Lenis | null>;
  items: HistoryItem[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  searchKeyword: string;
  filterType: string;
  triggerLoadMore: () => void;
}

export interface UseVirtualScrollReturn {
  contentRef: React.RefObject<HTMLDivElement | null>;
  scrollMetrics: ScrollMetrics;
  isScrolling: boolean;
  timelineExpanded: boolean;
  setTimelineExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  timelineNodes: TimelineNode[];
  timelineGroupIndices: Record<TimeGroup, number>;
  timelineHideTimerRef: React.MutableRefObject<number | null>;
  handleScrollToIndex: (index: number, align?: "start" | "center" | "end" | "auto") => void;
  handleTimelineWheel: (deltaY: number) => void;
  handleDragScroll: (scrollTop: number) => void;
}

// ===== 辅助 =====

function getTimeGroup(timeStr: string): TimeGroup {
  const now = new Date();
  const t = new Date(timeStr.replace(" ", "T"));
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86400000);

  if (t >= todayStart) return "today";
  if (t >= yesterdayStart) return "yesterday";
  if (t >= weekStart) return "thisWeek";
  return "earlier";
}

// ===== Hook =====

export function useVirtualScroll({
  scrollRef,
  lenisRef,
  items,
  virtualizer,
  searchKeyword,
  filterType,
  triggerLoadMore,
}: UseVirtualScrollOptions): UseVirtualScrollReturn {
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
  const [isScrolling, setIsScrolling] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  // Lenis 需要 wrapper（固定视口）≠ content（内容元素），否则数据变化后 scrollHeight 不同步导致滚动锁死
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const timelineHideTimerRef = useRef<number | null>(null);

  // ── handleScroll：标记滚动中（禁用 hover Popover，120ms 无滚动后复位）──
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    setIsScrolling(true);
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      setIsScrolling(false);
    }, 120);
  }, []);

  // ── 卸载时清理 timer ──
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      if (timelineHideTimerRef.current !== null) {
        window.clearTimeout(timelineHideTimerRef.current);
        timelineHideTimerRef.current = null;
      }
    };
  }, []);

  // ── 初始化时间轴滚动指标 ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollMetrics({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    });
  }, [items.length, scrollRef]);

  // ── Lenis 平滑滚动引擎 ──
  // scrollMetrics 同步也在此处完成，避免 Lenis scroll → dispatchEvent → setState → 重渲染的无限循环
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

    function raf(time: number) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    const rafId = requestAnimationFrame(raf);

    // scrollMetrics rAF 节流同步给 Timeline（直接用 Lenis 内部状态）
    let metricsRafId = 0;
    const updateMetrics = () => {
      if (metricsRafId) return;
      metricsRafId = requestAnimationFrame(() => {
        metricsRafId = 0;
        setScrollMetrics({
          scrollHeight: lenis.dimensions.scrollHeight,
          clientHeight: lenis.dimensions.height,
          scrollTop: lenis.scroll,
        });
      });
    };

    // Lenis scroll 回调：同步 scrollMetrics + 触底加载 + 派发原生 scroll 事件给虚拟列表
    let dispatchingScroll = false;
    lenis.on("scroll", ({ scroll }: Lenis) => {
      handleScroll();
      updateMetrics();
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
      if (metricsRafId) cancelAnimationFrame(metricsRafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [scrollRef, triggerLoadMore, handleScroll]);

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
  }, [items, virtualizer]);

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

  // ── Timeline 滚轮 → Lenis scrollTo 平滑滚动 ──
  const handleTimelineWheel = useCallback((deltaY: number) => {
    const lenis = lenisRef.current;
    if (!lenis) return;
    const target = Math.max(0, Math.min(lenis.limit, lenis.scroll + deltaY));
    lenis.scrollTo(target, { lerp: 0.08, duration: 1.2 });
  }, []);

  // ── 拖拽时间轴滚动 ──
  const handleDragScroll = useCallback((scrollTop: number) => {
    const lenis = lenisRef.current;
    if (lenis) {
      lenis.scrollTo(scrollTop, { immediate: true });
    }
  }, []);

  // ── 时间轴节点计算 ──
  const timelineNodes = useMemo<TimelineNode[]>(() => {
    if (searchKeyword || filterType !== "all") return [];
    return items.map((item, idx) => ({
      group: getTimeGroup(item.time),
      index: idx,
      // 图文混排的 text 存的是真实文字，和 text 类型一样可直接当标题用
      label:
        item.type === "text" || item.type === "rich"
          ? item.text.slice(0, 15)
          : item.type === "image"
            ? "图片"
            : "文件",
      type: item.type as "text" | "image" | "file" | "rich",
      time: item.time,
    }));
  }, [items, searchKeyword, filterType]);

  // ── 分组索引映射 ──
  const timelineGroupIndices = useMemo<Record<TimeGroup, number>>(() => {
    const result: Record<TimeGroup, number> = {
      today: -1,
      yesterday: -1,
      thisWeek: -1,
      earlier: -1,
    };
    if (searchKeyword || filterType !== "all") return result;
    for (let i = 0; i < items.length; i++) {
      const group = getTimeGroup(items[i].time);
      if (result[group] === -1) result[group] = i;
    }
    return result;
  }, [items, searchKeyword, filterType]);

  return {
    contentRef,
    scrollMetrics,
    isScrolling,
    timelineExpanded,
    setTimelineExpanded,
    timelineNodes,
    timelineGroupIndices,
    timelineHideTimerRef,
    handleScrollToIndex,
    handleTimelineWheel,
    handleDragScroll,
  };
}
