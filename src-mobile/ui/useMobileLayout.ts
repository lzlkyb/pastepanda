import { useSyncExternalStore } from "react";

/** 手机方向来自系统；输入法缩小布局视口时不能误切换为横屏。 */
export function getMobileLandscape() {
  if (window.matchMedia("(pointer: coarse)").matches) {
    if (window.screen.orientation?.type) return window.screen.orientation.type.startsWith("landscape");
    if (typeof window.orientation === "number") return Math.abs(window.orientation) === 90;
  }
  return window.matchMedia("(orientation: landscape)").matches;
}

function subscribe(listener: () => void) {
  const media = window.matchMedia("(orientation: landscape)");
  media.addEventListener("change", listener);
  window.screen.orientation?.addEventListener("change", listener);
  window.addEventListener("orientationchange", listener);
  return () => {
    media.removeEventListener("change", listener);
    window.screen.orientation?.removeEventListener("change", listener);
    window.removeEventListener("orientationchange", listener);
  };
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, getMobileLandscape);
}
