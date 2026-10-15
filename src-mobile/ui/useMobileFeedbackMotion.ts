import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

const ease = "cubic-bezier(0.2, 0, 0, 1)";

/** Finite, event-driven transitions; no observer or animation runs between changes. */
export function useMobileFeedbackMotion(root: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, tone: string) {
  const previous = useRef<{ text: string; height: number; tone: string } | null>(null);
  const animations = useRef<Animation[]>([]);
  const [, setRevision] = useState(0);
  useLayoutEffect(() => {
    const element = root.current, body = content.current;
    if (!element || !body) return;
    const style = getComputedStyle(element);
    const height = body.getBoundingClientRect().height + (element === body ? 0 : (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0));
    const text = body.textContent ?? "", before = previous.current;
    previous.current = { text, height, tone };
    const contentChanged = !before || before.text !== text || before.tone !== tone;
    if (!contentChanged && before?.height === height) return;
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    if (document.hidden || element.closest('[hidden], [inert]') || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !body.animate) return;
    if (contentChanged) animations.current.push(body.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 150, easing: ease }));
    if (before && before.height > 0 && height > 0 && before.height !== height)
      animations.current.push(element.animate([{ height: `${before.height}px` }, { height: `${height}px` }], { duration: 200, easing: ease }));
  });
  useLayoutEffect(() => {
    const stop = () => { animations.current.forEach(animation => animation.cancel()); animations.current = []; };
    const hidden = () => {
      if (root.current) root.current.dataset.motionPaused = String(document.hidden);
      if (document.hidden) stop();
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", hidden);
    hidden();
    reduced.addEventListener("change", stop);
    return () => { stop(); document.removeEventListener("visibilitychange", hidden); reduced.removeEventListener("change", stop); };
  }, [root]);
  return useCallback(() => setRevision(value => value + 1), []);
}
