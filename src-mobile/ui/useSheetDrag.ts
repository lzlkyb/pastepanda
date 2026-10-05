import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createMobileSpring, type MobileSpring } from "./mobileSpring";

/** Only the handle drags; body scrolling must never dismiss a sheet. */
export function useSheetDrag(open: boolean, onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const spring = useRef<MobileSpring | null>(null);
  const [present, setPresent] = useState(open);
  const active = useRef<{
    id: number;
    start: number;
    origin: number;
    distance: number;
    moved: number;
    time: number;
    velocity: number;
  } | null>(null);
  const releaseVelocity = useRef<number | undefined>(undefined);
  const closing = useRef(false);
  const visibleHeight = useRef(0);
  const ensureSpring = useCallback(() => {
    if (!spring.current && sheetRef.current) {
      const element = sheetRef.current;
      spring.current = createMobileSpring(0, (value) => {
        element.style.setProperty("--mobile-sheet-offset", `${Math.max(0, value)}px`);
        // Once entirely offscreen there is no visible spring tail to wait for; release modal focus.
        if (closing.current && visibleHeight.current > 0 && value >= visibleHeight.current) setPresent(false);
      });
    }
    return spring.current;
  }, []);
  useLayoutEffect(() => {
    if (open) setPresent(true);
  }, [open]);
  useLayoutEffect(() => {
    if (!present || !sheetRef.current) return;
    const fresh = !spring.current;
    const motion = ensureSpring();
    if (!motion) return;
    visibleHeight.current = sheetRef.current.offsetHeight;
    const height = visibleHeight.current + 16;
    closing.current = !open;
    if (fresh && open) motion.set(height);
    active.current = null;
    sheetRef.current.removeAttribute("data-dragging");
    motion.move(open ? 0 : height, releaseVelocity.current, open ? undefined : () => setPresent(false));
    releaseVelocity.current = undefined;
  }, [open, present, ensureSpring]);
  useLayoutEffect(
    () => () => {
      spring.current?.dispose();
      spring.current = null;
      active.current = null;
    },
    [present],
  );
  useLayoutEffect(() => {
    const element = sheetRef.current;
    if (!present || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      visibleHeight.current = element.offsetHeight;
      if (closing.current) spring.current?.move(visibleHeight.current + 16, undefined, () => setPresent(false));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [present]);
  const cancel = useCallback(() => {
    if (!active.current) return;
    active.current = null;
    sheetRef.current?.removeAttribute("data-dragging");
    spring.current?.move(0, 0);
  }, []);
  useEffect(() => {
    if (!present) return;
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [present, cancel]);
  return {
    present,
    sheetRef,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (!open || active.current || event.button !== 0) return;
      const current = ensureSpring()?.stop().position ?? 0;
      active.current = {
        id: event.pointerId,
        start: event.clientY,
        origin: Math.max(0, current),
        distance: Math.max(0, current),
        moved: 0,
        time: event.timeStamp,
        velocity: 0,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      sheetRef.current?.setAttribute("data-dragging", "true");
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const drag = active.current;
      if (!drag || drag.id !== event.pointerId) return;
      const distance = Math.max(0, drag.origin + event.clientY - drag.start);
      const elapsed = event.timeStamp - drag.time;
      if (elapsed > 0) drag.velocity = ((distance - drag.distance) / elapsed) * 1000;
      drag.time = event.timeStamp;
      drag.distance = distance;
      drag.moved = Math.max(drag.moved, Math.abs(event.clientY - drag.start));
      spring.current?.set(distance);
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const drag = active.current;
      if (!drag || drag.id !== event.pointerId) return;
      const distance = Math.max(0, drag.origin + event.clientY - drag.start);
      const velocity = event.timeStamp - drag.time > 80 ? 0 : drag.velocity;
      const moved = Math.max(drag.moved, Math.abs(event.clientY - drag.start));
      active.current = null;
      sheetRef.current?.removeAttribute("data-dragging");
      spring.current?.set(distance);
      if (distance > 80 || (distance > 16 && velocity > 600) || moved < 4) {
        releaseVelocity.current = velocity;
        onClose();
      } else spring.current?.move(0, velocity);
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) onClose();
    },
  };
}
