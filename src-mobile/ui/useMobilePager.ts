import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type UIEvent } from "react";

export const MOBILE_TABS = ["devices", "files", "settings"] as const;
export type MobileTab = (typeof MOBILE_TABS)[number];

/** 原生滚动负责手势和吸附；导航只在整页落定后激活业务页。 */
export function useMobilePager(active: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLSpanElement>(null);
  const [tab, setTab] = useState<MobileTab>("devices");
  const committed = useRef<MobileTab>("devices");
  const requested = useRef<MobileTab | null>(null);
  const queued = useRef<MobileTab | null>(null);
  const enabled = useRef(active);
  enabled.current = active;
  const width = useRef(0);
  const moving = useRef(false);
  const touches = useRef(0);
  const suppressClick = useRef(false);
  const lastScrollAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finishRef = useRef<() => void>(() => {});
  const blocked = useCallback(() => !enabled.current || document.hidden || !!document.body.dataset.mobileSheets, []);
  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const draw = useCallback(() => {
    const node = contentRef.current;
    if (!node || !width.current) return;
    const position = Math.max(0, Math.min(2, node.scrollLeft / width.current));
    selectionRef.current?.style.setProperty("--mobile-tab-offset", `${position * 100}%`);
  }, []);
  const markMoving = useCallback((value: boolean) => {
    moving.current = value;
    if (contentRef.current) contentRef.current.dataset.moving = String(value);
  }, []);
  const finish = useCallback(() => {
    const node = contentRef.current;
    if (!node || !width.current || touches.current || blocked()) return;
    const position = node.scrollLeft / width.current;
    const index = Math.max(0, Math.min(2, Math.round(position)));
    // 分数像素会造成不足 1px 的舍入差；中途 scrollend 不能提前激活目标页。
    if (Math.abs(node.scrollLeft - index * width.current) > 1) {
      // 静止后仍未落在整页上（部分 WebView 分数像素 / 程序化滚动被打断）：
      // 吸附到最近整页再提交，否则 moving 滞留会一直吞掉业务点击。
      // 重试间隔必须短于 200ms 静止阈值，否则首查即达标、等不到「真静止」。
      if (Date.now() - lastScrollAt.current < 200) {
        clearTimer();
        timer.current = setTimeout(() => finishRef.current(), 160);
        return;
      }
      node.scrollTo({ left: index * width.current, behavior: "instant" });
    }
    const next = MOBILE_TABS[index];
    if (requested.current && requested.current !== next) return;
    clearTimer();
    requested.current = null;
    committed.current = next;
    setTab(next);
    markMoving(false);
    draw();
  }, [blocked, clearTimer, draw, markMoving]);
  finishRef.current = finish;
  const scheduleFinish = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(finish, 160);
  }, [clearTimer, finish]);
  const abort = useCallback(() => {
    clearTimer();
    requested.current = null;
    touches.current = 0;
    suppressClick.current = false;
    contentRef.current?.scrollTo({ left: MOBILE_TABS.indexOf(committed.current) * width.current, behavior: "instant" });
    markMoving(false);
    draw();
  }, [clearTimer, draw, markMoving]);
  const selectTab = useCallback(
    (next: MobileTab) => {
      if (!enabled.current || document.hidden) return;
      // 业务按钮可能在关闭弹层的同一次点击中跳转；等待模态背景解锁再执行。
      if (document.body.dataset.mobileSheets) {
        queued.current = next;
        return;
      }
      const node = contentRef.current;
      if (!node || !width.current) return;
      queued.current = null;
      requested.current = next;
      const index = MOBILE_TABS.indexOf(next);
      const position = node.scrollLeft / width.current;
      const smooth =
        Math.abs(position - index) <= 1.01 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      clearTimer();
      markMoving(Math.abs(node.scrollLeft - index * width.current) > 1);
      node.scrollTo({ left: index * width.current, behavior: smooth ? "smooth" : "instant" });
      // 即时导航无需等下一次 scrollend；平滑导航只安排旧 WebView 的静止兜底。
      if (!smooth || !moving.current) finish();
      else scheduleFinish();
    },
    [clearTimer, finish, markMoving, scheduleFinish],
  );

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    width.current = node.getBoundingClientRect().width;
    abort();
    const resize = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      // 键盘、通知和内容高度变化不能重置横向分页。
      if (next <= 0 || Math.abs(next - width.current) < 0.5) return;
      width.current = next;
      abort();
    });
    resize.observe(node);
    return () => {
      resize.disconnect();
      clearTimer();
    };
  }, [abort, clearTimer]);
  useLayoutEffect(() => {
    if (!active) queued.current = null;
    abort();
  }, [active, abort]);
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const start = (event: TouchEvent) => {
      if (blocked()) return;
      touches.current = event.touches.length;
      requested.current = null;
      suppressClick.current = false;
    };
    const end = (event: TouchEvent) => {
      touches.current = event.touches.length;
      if (!touches.current && moving.current) scheduleFinish();
    };
    const sheets = new MutationObserver(() => {
      if (document.body.dataset.mobileSheets) abort();
      else if (queued.current) selectTab(queued.current);
    });
    sheets.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-sheets"] });
    const visibility = () => {
      if (document.hidden) {
        queued.current = null;
        abort();
      }
    };
    node.addEventListener("scrollend", finish);
    node.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    window.addEventListener("touchcancel", end, { passive: true });
    window.addEventListener("blur", abort);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      sheets.disconnect();
      clearTimer();
      node.removeEventListener("scrollend", finish);
      node.removeEventListener("touchstart", start);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      window.removeEventListener("blur", abort);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [abort, blocked, clearTimer, finish, scheduleFinish, selectTab]);

  return {
    tab,
    selectTab,
    contentRef,
    selectionRef,
    events: {
      onScroll: (event: UIEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (blocked()) {
          abort();
          return;
        }
        lastScrollAt.current = Date.now();
        draw();
        markMoving(true);
        if (touches.current) suppressClick.current = true;
        scheduleFinish();
      },
      onPointerDown: () => {
        if (!moving.current) suppressClick.current = false;
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (!moving.current && !suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
