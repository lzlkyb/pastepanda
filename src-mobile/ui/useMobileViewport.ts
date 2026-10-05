import { useLayoutEffect } from "react";
import { useMobileLayout } from "./useMobileLayout";

/** 键盘改变 visualViewport 而不总是改变布局高度；工具栏跟随实际可见区。 */
export function useMobileViewport() {
  const landscape = useMobileLayout();
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.mobileLayout = landscape ? "landscape" : "portrait";
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--mobile-viewport-height", `${height}px`);
      root.style.setProperty("--mobile-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      const focused = document.activeElement?.matches("input,textarea,[contenteditable=true]");
      const keyboard = height < window.innerHeight - 120 || (focused && window.matchMedia("(pointer: coarse)").matches && height < window.screen.height * 0.75);
      root.dataset.mobileKeyboard = keyboard ? "true" : "false";
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-top");
      delete root.dataset.mobileLayout;
      delete root.dataset.mobileKeyboard;
    };
  }, [landscape]);
}
