import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/** Shared visible reading time for ordinary outcomes; errors never expire. */
export function useMobileNoticeTimer(enabled: boolean, title: ReactNode, dismiss: () => void, paused = false, host?: RefObject<HTMLElement | null>) {
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
      const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"]');
      const inVisibleSheet = !!host?.current?.closest('[role="dialog"][data-state="open"]') && host.current.closest('[role="dialog"]') === dialogs[dialogs.length - 1];
      const hiddenPage = !!host?.current?.closest('[hidden],[inert],[aria-hidden="true"]');
      let hiddenByStyle = false;
      for (let node = host?.current; node && !hiddenPage; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") { hiddenByStyle = true; break; }
      }
      if (document.hidden || hiddenPage || hiddenByStyle || (document.body.dataset.mobileSheets && !inVisibleSheet) || paused) { stop(); return; }
      if (timer !== undefined) return;
      started = Date.now();
      timer = setTimeout(dismiss, Math.max(0, remaining.current));
    };
    const modal = new MutationObserver(update);
    modal.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-mobile-sheets", "hidden", "inert", "aria-hidden", "data-reading", "data-preview-source"] });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.visualViewport?.addEventListener("resize", update);
    update();
    return () => {
      stop(); modal.disconnect(); document.removeEventListener("visibilitychange", update);
      window.removeEventListener("resize", update); window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [enabled, title, dismiss, paused, host]);
}
