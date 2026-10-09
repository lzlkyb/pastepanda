import { useCallback, useEffect, useRef, useState } from "react";
import { useMobileBack } from "./useMobileBack";

/** Primary destinations switch by intent, independently of content gestures. */
export function useMobileNavigation<T extends string>(destinations: readonly T[], initial: T, active: boolean) {
  const [tab, setTab] = useState(initial);
  const enabled = useRef(active);
  const available = useRef(destinations);
  const queued = useRef<T | null>(null);
  enabled.current = active;
  available.current = destinations;
  const selectTab = useCallback((next: T) => {
    if (!enabled.current || document.hidden || !available.current.includes(next)) return;
    // A sheet can navigate in the click that closes it. Its exit/focus cleanup
    // must finish before the next destination becomes interactive.
    if (document.body.dataset.mobileSheets) { queued.current = next; return; }
    queued.current = null;
    setTab(next);
  }, []);
  useEffect(() => {
    if (!active) { queued.current = null; return; }
    const flush = () => {
      if (queued.current !== null && !document.body.dataset.mobileSheets) selectTab(queued.current);
    };
    const observer = new MutationObserver(flush);
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-sheets"] });
    // Sheet cleanup may finish while Android has backgrounded the WebView.
    document.addEventListener("visibilitychange", flush);
    flush();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", flush); };
  }, [active, selectTab]);
  useMobileBack(active && tab !== initial, () => selectTab(initial), false, -100);
  return { tab, selectTab };
}
