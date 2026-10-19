import { useState, useRef, useEffect } from "react";

/**
 * 置顶切换瞬间标记（方案 C 动画）：item.pinned 发生翻转后约 1s 内返回 true，
 * 驱动 ★ 弹跳、📌 弹出、"置顶"徽章渐显等一次性动画——
 * 仅响应真实切换，初始加载的已置顶卡片不会播放。
 */
export function usePinFlash(pinned: boolean): boolean {
  const prevRef = useRef(pinned);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prevRef.current === pinned) return;
    prevRef.current = pinned;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1000);
    return () => window.clearTimeout(t);
  }, [pinned]);
  return flash;
}
