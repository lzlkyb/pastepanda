/**
 * 按画布容器实际宽度判定用哪套 chrome 布局。
 *
 * 为何用 ResizeObserver 而不是 CSS 容器查询：两档的区别不只是样式——
 * 形状库要从常驻竖栏变成 popover、MiniMap 要整个不渲染，这些是 DOM 结构变化，
 * 容器查询驱动不了 JS。一个数据源同时驱动结构与样式，不会出现两边对不上的中间态。
 */
import { useEffect, useState, type RefObject } from "react";
import { COMPACT_MAX_WIDTH } from "./chrome/types";

export function useCompactChrome(ref: RefObject<HTMLElement | null>): boolean {
  // 初值给 false（宽档）：ResizeObserver 首次回调在挂载后立即到，
  // 给 true 反而会让宽窗口下闪一下紧凑布局。
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // w 为 0 是容器还没布局（比如弹窗入场动画的第一帧），别拿它下结论
      if (w > 0) setCompact(w < COMPACT_MAX_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return compact;
}
