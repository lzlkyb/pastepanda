import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type Lenis from "lenis";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import { canAnimateInterface } from "@/lib/utils";
import { MOTION } from "@/lib/motion";

/** Animate the result container, never the virtual rows' positioning transforms. */
export function useHistoryFilterMotion({ filterKey, ready, lenisRef }: {
  filterKey: string; ready: boolean; lenisRef: RefObject<Lenis | null>;
}) {
  const mode = useInterfaceMotion();
  const transitionRef = useRef<HTMLDivElement>(null);
  const previous = useRef(filterKey);
  const pending = useRef<string | null>(null);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (previous.current !== filterKey) {
      previous.current = filterKey;
      pending.current = filterKey;
      animation.current?.cancel(); animation.current = null;
      lenisRef.current?.scrollTo(0, { immediate: true });
    }
    if (mode !== "full" || !canAnimateInterface()) {
      pending.current = null;
      animation.current?.cancel(); animation.current = null;
      return;
    }
    const el = transitionRef.current;
    if (!ready || pending.current !== filterKey || !el) return;
    pending.current = null;
    if (typeof el.animate !== "function") return;
    const active = el.animate([
      { opacity: .35, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: MOTION.base * 1000, easing: "cubic-bezier(0.05,0.7,0.1,1)" });
    animation.current = active;
    void active.finished.then(() => {
      if (animation.current === active) animation.current = null;
    }, () => {});
  }, [filterKey, ready, mode, lenisRef]);
  useEffect(() => () => { animation.current?.cancel(); }, []);
  return transitionRef;
}
