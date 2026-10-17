import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { canAnimateInterface } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useInterfaceMotion } from "@/components/MotionPolicy";

/** Measure only mounted rows during an actual data operation. Never animate the
 * virtualizer's positioning transform: scroll/recycling must remain immediate. */
export function useListMotion(items: readonly { id: string }[], scrollRef: RefObject<HTMLDivElement | null>) {
  const mode = useInterfaceMotion();
  const rowsWrapRef = useRef<HTMLDivElement>(null);
  const snapshot = useRef<Map<string, number> | null>(null);
  const animations = useRef(new Set<Animation>());
  const [landingId, setLandingId] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const active = animations.current;
    const cancel = () => { active.forEach(animation => animation.cancel()); active.clear(); snapshot.current = null; };
    if (mode !== "full") { cancel(); clearTimeout(clearTimer.current); setLandingId(null); return; }
    const prepare = (event: Event) => {
      if (!canAnimateInterface()) return;
      const rows = rowsWrapRef.current?.children;
      if (!rows) return;
      // Read the current visual positions before cancelling a previous transition,
      // so an interrupted operation continues from what the user can see.
      const positions = new Map<string, number>();
      for (const row of Array.from(rows).slice(0, 64)) {
        const id = (row as HTMLElement).dataset.itemId;
        const content = row.firstElementChild;
        if (id && content) positions.set(id, content.getBoundingClientRect().top);
      }
      cancel(); snapshot.current = positions;
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      clearTimeout(clearTimer.current);
      setLandingId(id ?? null);
      if (id) clearTimer.current = setTimeout(() => setLandingId(null), 400);
    };
    const events = ["new-anim", "pin-anim", "delete-anim"];
    events.forEach(event => window.addEventListener(event, prepare));
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", cancel, { passive: true });
    return () => {
      events.forEach(event => window.removeEventListener(event, prepare));
      scroll?.removeEventListener("scroll", cancel);
      clearTimeout(clearTimer.current); cancel();
    };
  }, [mode, scrollRef]);

  useLayoutEffect(() => {
    const previous = snapshot.current;
    snapshot.current = null;
    if (!previous || !canAnimateInterface()) return;
    const rows = rowsWrapRef.current?.children;
    if (!rows) return;
    for (const row of Array.from(rows).slice(0, 64)) {
      const id = (row as HTMLElement).dataset.itemId;
      const content = row.firstElementChild;
      if (!id || !content || typeof content.animate !== "function") continue;
      const top = previous.get(id);
      const delta = top === undefined ? 4 : top - content.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      const animation = content.animate([
        { transform: `translateY(${delta}px)`, opacity: top === undefined ? 0.7 : 1 },
        { transform: "translateY(0)", opacity: 1 },
      ], { duration: MOTION.base * 1000, easing: "cubic-bezier(0.2,0,0,1)" });
      const active = animations.current;
      active.add(animation);
      void animation.finished.then(() => active.delete(animation), () => active.delete(animation));
    }
  }, [items]);
  return { rowsWrapRef, landingId };
}
