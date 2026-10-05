import { useCallback, useEffect, useRef, useState } from "react";

/** 设计稿专用：滚动交给浏览器，只在整页落定时提交业务页。 */
export function usePreviewPager() {
  const pager = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const selected = useRef(0);
  const moving = useRef(false);
  const touching = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const finish = useCallback(() => {
    const node = pager.current;
    if (!node || touching.current || !node.clientWidth) return;
    const position = node.scrollLeft / node.clientWidth;
    const index = Math.max(0, Math.min(2, Math.round(position)));
    if (Math.abs(position - index) > 0.005) return;
    selected.current = index;
    moving.current = false;
    setActive(index);
    setBusy(false);
  }, []);
  const onScroll = useCallback(() => {
    const node = pager.current;
    if (!node) return;
    const position = Math.max(0, Math.min(2, node.scrollLeft / node.clientWidth));
    indicator.current?.style.setProperty("--mobile-tab-offset", `${position * 100}%`);
    if (!moving.current) {
      moving.current = true;
      setBusy(true);
    }
    clearTimeout(timer.current);
    // scrollend 缺失的 WebView 使用停止滚动后的整页位置确认，触摸未结束不提交。
    timer.current = setTimeout(finish, 160);
  }, [finish]);
  const go = useCallback(
    (index: number) => {
      const node = pager.current;
      if (!node) return;
      if (touching.current) return;
      const current = node.scrollLeft / node.clientWidth;
      const adjacent = Math.abs(current - index) <= 1.01;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollTo({ left: index * node.clientWidth, behavior: adjacent && !reduced ? "smooth" : "instant" });
      if (Math.abs(current - index) < 0.005) finish();
    },
    [finish],
  );
  useEffect(() => {
    const node = pager.current!;
    const end = () => finish();
    const start = () => {
      touching.current = true;
    };
    const release = () => {
      touching.current = false;
      clearTimeout(timer.current);
      timer.current = setTimeout(finish, 160);
    };
    node.addEventListener("scrollend", end);
    node.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchend", release, { passive: true });
    window.addEventListener("touchcancel", release, { passive: true });
    let lastWidth = node.getBoundingClientRect().width;
    const resize = new ResizeObserver(() => {
      const width = node.getBoundingClientRect().width;
      // 提示、内容和捕获画面引起的高度变化不能重置正在进行的横向滚动。
      if (!node.clientWidth || Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      node.scrollTo({ left: selected.current * node.clientWidth, behavior: "instant" });
      finish();
    });
    resize.observe(node);
    return () => {
      clearTimeout(timer.current);
      resize.disconnect();
      node.removeEventListener("scrollend", end);
      node.removeEventListener("touchstart", start);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, [finish]);
  return { pager, indicator, active, busy, go, onScroll, moving };
}
