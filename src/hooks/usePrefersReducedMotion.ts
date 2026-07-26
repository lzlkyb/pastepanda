import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** 非响应式读取 — 供事件回调 / 一次性初始化使用（不订阅变化） */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(QUERY).matches;
}

/**
 * #3 OS 级「减少动态效果」偏好（响应式）。
 * 与 framer <MotionConfig reducedMotion="user">、globals.css 的
 * @media (prefers-reduced-motion: reduce) 全局降级、以及 dialogMotion 的
 * DISABLED 通道联动：开启时位移/缩放/循环动画降级为即时，仅保留淡入淡出。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
