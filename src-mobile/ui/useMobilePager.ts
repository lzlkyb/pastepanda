import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type UIEvent } from "react";

/** Native scrolling owns momentum; business navigation is committed only after snap settlement. */
export function useMobilePager<T extends string>(destinations: readonly T[], tab: T, onSelect: (next: T) => void, enabled: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);
  const current = useRef({ destinations, tab, onSelect, enabled });
  current.current = { destinations, tab, onSelect, enabled };
  const width = useRef(0), requested = useRef<T | null>(null), touches = useRef(0);
  const suppressed = useRef(false), movingRef = useRef(false), touchBlocked = useRef(false);
  const lastScroll = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finishRef = useRef<() => void>(() => {});
  const blocked = useCallback(() => !current.current.enabled || document.hidden || !!document.body.dataset.mobileSheets || !!document.body.dataset.mobileBack, []);
  const clearTimer = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  const markMoving = useCallback((value: boolean) => {
    movingRef.current = value; setMoving(value);
    if (contentRef.current) contentRef.current.dataset.moving = String(value);
  }, []);
  const abort = useCallback(() => {
    clearTimer(); requested.current = null;
    const node = contentRef.current;
    if (node && width.current) node.scrollTo({ left: current.current.destinations.indexOf(current.current.tab) * width.current, behavior: "instant" });
    markMoving(false);
  }, [clearTimer, markMoving]);
  const schedule = useCallback(() => {
    clearTimer(); timer.current = setTimeout(() => finishRef.current(), 160);
  }, [clearTimer]);
  const finish = useCallback(() => {
    const node = contentRef.current, state = current.current;
    if (!node || !width.current || touches.current || blocked() || touchBlocked.current) return;
    const nearest = Math.max(0, Math.min(state.destinations.length - 1, Math.round(node.scrollLeft / width.current)));
    const target = requested.current === null ? nearest : state.destinations.indexOf(requested.current);
    // Old scrollend and interrupted smooth scrolling must not override the latest button intent.
    if (nearest !== target || Math.abs(node.scrollLeft - target * width.current) > 1) {
      if (performance.now() - lastScroll.current < 200) { schedule(); return; }
      node.scrollTo({ left: target * width.current, behavior: "instant" });
    }
    clearTimer(); requested.current = null; markMoving(false);
    const next = state.destinations[target];
    if (next !== state.tab) { current.current = { ...state, tab: next }; state.onSelect(next); }
  }, [blocked, clearTimer, markMoving, schedule]);
  finishRef.current = finish;
  const navigate = useCallback((next: T) => {
    const state = current.current, node = contentRef.current;
    if (!state.enabled || document.hidden || !state.destinations.includes(next)) return;
    if (document.body.dataset.mobileSheets) { state.onSelect(next); return; }
    if (!node || !width.current || document.body.dataset.mobileBack) return;
    requested.current = next; touchBlocked.current = false; touches.current = 0;
    delete node.dataset.touchBlocked;
    const index = state.destinations.indexOf(next), position = node.scrollLeft / width.current;
    const smooth = Math.abs(index - position) <= 1.01 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    markMoving(Math.abs(node.scrollLeft - index * width.current) > 1);
    lastScroll.current = performance.now();
    node.scrollTo({ left: index * width.current, behavior: smooth ? "smooth" : "instant" });
    if (smooth && movingRef.current) schedule(); else finish();
  }, [finish, markMoving, schedule]);
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    width.current = node.getBoundingClientRect().width; abort();
    const resize = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      // Only actual width changes realign pages; notices and IME height do not erase an in-flight swipe.
      if (next <= 0 || Math.abs(next - width.current) < .5) return;
      width.current = next; touches.current = 0; touchBlocked.current = false; delete node.dataset.touchBlocked; abort();
    });
    resize.observe(node);
    return () => { resize.disconnect(); clearTimer(); };
  }, [abort, clearTimer]);
  useLayoutEffect(() => { touches.current = 0; touchBlocked.current = false; delete contentRef.current?.dataset.touchBlocked; abort(); }, [tab, enabled, abort]);
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const start = (event: TouchEvent) => {
      suppressed.current = false;
      touches.current = event.touches.length;
      const target = event.target instanceof Element ? event.target : null, point = event.touches[0];
      const bounds = node.getBoundingClientRect(), tokens = getComputedStyle(document.documentElement);
      const left = Math.max(24, parseFloat(tokens.getPropertyValue("--mobile-system-gesture-left")) || 0);
      const right = Math.max(24, parseFloat(tokens.getPropertyValue("--mobile-system-gesture-right")) || 0);
      const localOwner = target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[data-mobile-gesture-owner]');
      let horizontalOwner = false;
      for (let ancestor = target; ancestor && ancestor !== node; ancestor = ancestor.parentElement) {
        const overflow = getComputedStyle(ancestor).overflowX;
        if (ancestor.scrollWidth > ancestor.clientWidth + 1 && /auto|scroll/.test(overflow)) { horizontalOwner = true; break; }
      }
      touchBlocked.current = blocked() || !point || event.touches.length !== 1 || !!localOwner || horizontalOwner
        || point.clientX - bounds.left < left || bounds.right - point.clientX < right;
      node.dataset.touchBlocked = String(touchBlocked.current);
      if (touchBlocked.current) abort(); else { requested.current = null; clearTimer(); }
    };
    const end = (event: TouchEvent) => {
      touches.current = event.touches.length;
      if (touches.current) return;
      const canceled = event.type === "touchcancel" || touchBlocked.current;
      // A local scroll can deliver momentum after release. Keep ownership until the next touch/navigation.
      if (canceled) { touchBlocked.current = true; node.dataset.touchBlocked = "true"; abort(); return; }
      touchBlocked.current = false; delete node.dataset.touchBlocked;
      if (movingRef.current) schedule();
    };
    const interrupt = () => { touchBlocked.current = true; node.dataset.touchBlocked = "true"; abort(); };
    const visibility = () => { if (document.hidden) interrupt(); };
    const modal = new MutationObserver(() => { if (blocked()) interrupt(); });
    modal.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-sheets", "data-mobile-back"] });
    node.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    window.addEventListener("touchcancel", end, { passive: true });
    node.addEventListener("scrollend", finish);
    window.addEventListener("mobile-interaction-cancel", interrupt);
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      modal.disconnect(); clearTimer();
      node.removeEventListener("touchstart", start); node.removeEventListener("scrollend", finish);
      window.removeEventListener("touchend", end); window.removeEventListener("touchcancel", end);
      window.removeEventListener("mobile-interaction-cancel", interrupt); window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [abort, blocked, clearTimer, finish, schedule]);
  return { contentRef, moving, navigate, events: {
    onPointerDownCapture() { if (!movingRef.current) suppressed.current = false; },
    onScroll(event: UIEvent<HTMLDivElement>) {
      if (event.target !== event.currentTarget) return;
      if (blocked() || touchBlocked.current) { abort(); return; }
      if (Math.abs(event.currentTarget.scrollLeft - current.current.destinations.indexOf(current.current.tab) * width.current) <= 1 && !requested.current) return;
      lastScroll.current = performance.now(); suppressed.current = true; markMoving(true); schedule();
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (event.detail !== 0 && (movingRef.current || suppressed.current)) { event.preventDefault(); event.stopPropagation(); }
    },
  } };
}
