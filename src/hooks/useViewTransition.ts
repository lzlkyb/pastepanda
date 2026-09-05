import { useEffect, useRef, useState } from "react";

/** 退场时长（ms）。必须与 `App.module.css` 里 `viewOut` 的 animation-duration 一致。 */
export const VIEW_OUT_MS = 140;

/**
 * 内容区视图切换的过渡层（记录 / 工具 / 知识 / 设置）。
 *
 * # 为什么是串行，不是交叉淡入淡出
 *
 * 四个视图都是 **普通流内元素**。同时渲染新旧两个的话，新的会接在旧的
 * **下面**而不是盖住它——页面突然变成两倍高然后弹回去。这个坑 `App.tsx`
 * 已经踩过（那三个 `!showSettings &&` 门控就是为它加的）。
 *
 * 要做交叉就得把 `.contentArea` 改成定位上下文、退场那个脱流，而记录模式里
 * 有 Sidebar + 虚拟滚动列表，脱流后高度与滚动位置都要重算——风险大于收益。
 *
 * # 首帧不播动画
 *
 * `shown` 初值直接取目标，开机第一帧就是最终态。开机就看到一次淡入
 * 反而像加载慢。
 *
 * @param target 目标视图的 key，如 `showSettings ? "settings" : appMode`
 * @returns `shown` = 当前该渲染哪个（可能落后于 `target` 最多一个退场时长）；
 *          `phase` = 给 `.contentArea` 挂哪个动画 class
 */
export function useViewTransition<T>(target: T): { shown: T; phase: "in" | "out" } {
  const [shown, setShown] = useState<T>(target);
  const [phase, setPhase] = useState<"in" | "out">("in");
  /** 首帧标记：初始渲染不算一次「切换」 */
  const firstRef = useRef(true);

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (target === shown) return;
    setPhase("out");
    // 退场放完才换人。这个 timer 会被下一次切换的 cleanup 清掉，
    // 所以快速连点不会排队播好几遍，只会直接去最新那个。
    const t = setTimeout(() => {
      setShown(target);
      setPhase("in");
    }, VIEW_OUT_MS);
    return () => clearTimeout(t);
  }, [target, shown]);

  return { shown, phase };
}
