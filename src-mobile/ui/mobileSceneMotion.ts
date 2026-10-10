const owners = new WeakMap<HTMLElement, { dispose: () => void }>();

/** Short, interruptible scene movement. Business state never lives inside an animation. */
export function createSceneMotion(element: HTMLElement) {
  owners.get(element)?.dispose();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animation: Animation | undefined;
  const stop = () => { animation?.cancel(); animation = undefined; };
  const settle = () => { stop(); element.style.removeProperty("--mobile-back-offset"); };
  const hidden = () => { if (document.hidden) settle(); };
  const preference = () => { if (reduced.matches) settle(); };
  document.addEventListener("visibilitychange", hidden);
  reduced.addEventListener("change", preference);
  const motion = {
    enter(direction: "forward" | "back" | "tab") {
      stop();
      if (reduced.matches || document.hidden || !element.animate) return;
      const distance = direction === "tab" ? 0 : direction === "back" ? -16 : 24;
      animation = element.animate([{ opacity: 0.6, transform: `translateX(${distance}px)` }, { opacity: 1, transform: "translateX(0)" }],
        { duration: direction === "tab" ? 150 : 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      const current = animation;
      current.onfinish = () => { if (animation === current) stop(); };
    },
    preview(progress: number, edge: "left" | "right") {
      stop();
      element.style.setProperty("--mobile-back-offset", reduced.matches ? "0px" : `${Math.min(96, element.clientWidth * 0.18) * progress * (edge === "left" ? 1 : -1)}px`);
    },
    cancelPreview() {
      const offset = element.style.getPropertyValue("--mobile-back-offset") || "0px";
      settle();
      if (reduced.matches || document.hidden || !element.animate) return;
      animation = element.animate([{ translate: `${offset} 0` }, { translate: "0px 0" }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      const current = animation;
      current.onfinish = () => { if (animation === current) stop(); };
    },
    dispose() {
      stop();
      if (owners.get(element) === motion) { element.style.removeProperty("--mobile-back-offset"); owners.delete(element); }
      document.removeEventListener("visibilitychange", hidden); reduced.removeEventListener("change", preference);
    },
  };
  owners.set(element, motion);
  return motion;
}
