const owners = new WeakMap<HTMLElement, { dispose: () => void }>();

/** Short, interruptible scene movement. Business state never lives inside an animation. */
export function createSceneMotion(element: HTMLElement) {
  owners.get(element)?.dispose();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animation: Animation | undefined;
  const stop = () => { animation?.cancel(); animation = undefined; };
  const clearPreview = () => { for (const name of ["--mobile-back-offset", "--mobile-back-scale", "--mobile-back-radius"]) element.style.removeProperty(name); };
  const settle = () => { stop(); clearPreview(); };
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
      const amount = reduced.matches ? 0 : Math.max(0, Math.min(1, progress));
      element.style.setProperty("--mobile-back-offset", `${Math.min(96, element.clientWidth * 0.18) * amount * (edge === "left" ? 1 : -1)}px`);
      element.style.setProperty("--mobile-back-scale", String(1 - .04 * amount));
      element.style.setProperty("--mobile-back-radius", `${16 * amount}px`);
    },
    cancelPreview(done?: () => void) {
      const offset = element.style.getPropertyValue("--mobile-back-offset") || "0px";
      const scale = element.style.getPropertyValue("--mobile-back-scale") || "1";
      const radius = element.style.getPropertyValue("--mobile-back-radius") || "0px";
      settle();
      if (reduced.matches || document.hidden || !element.animate) return false;
      animation = element.animate([{ translate: `${offset} 0`, scale, borderRadius: radius }, { translate: "0px 0", scale: "1", borderRadius: "0px" }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      const current = animation;
      current.onfinish = () => { if (animation === current) { stop(); done?.(); } };
      return true;
    },
    dispose() {
      stop();
      if (owners.get(element) === motion) { clearPreview(); owners.delete(element); }
      document.removeEventListener("visibilitychange", hidden); reduced.removeEventListener("change", preference);
    },
  };
  owners.set(element, motion);
  return motion;
}
