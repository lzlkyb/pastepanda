import { useEffect, useRef, type ReactNode } from "react";

/** Shared visible reading time for ordinary outcomes; errors never expire. */
export function useMobileNoticeTimer(enabled: boolean, title: ReactNode, dismiss: () => void, paused = false) {
  const remaining = useRef(4000);
  useEffect(() => { remaining.current = 4000; }, [title, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer === undefined) return;
      clearTimeout(timer); timer = undefined;
      remaining.current -= Date.now() - started;
    };
    const update = () => {
      if (document.hidden || document.body.dataset.mobileSheets || paused) { stop(); return; }
      if (timer !== undefined) return;
      started = Date.now();
      timer = setTimeout(dismiss, Math.max(0, remaining.current));
    };
    const modal = new MutationObserver(update);
    modal.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-sheets"] });
    document.addEventListener("visibilitychange", update);
    update();
    return () => { stop(); modal.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [enabled, title, dismiss, paused]);
}
