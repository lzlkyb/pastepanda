/**
 * 知识模式的布局档位（B1 #1，设计稿 §10）。
 *
 * **断点沿用项目现有的 600 / 800**（`src/styles/app.css` 已经在给 `.card-list` 用）。
 * 再引入第三套断点只会让以后改布局时没人知道该改哪一档。
 *
 * | 宽度        | 侧栏       | 点一条笔记 |
 * |-------------|------------|--------------|
 * | < 600px     | 可收，默认收 | 弹窗 |
 * | 600–800px   | 常驻       | 弹窗 |
 * | ≥ 800px     | 常驻       | **第三栏** |
 *
 * 用 matchMedia 而不是监 resize：同 `usePrefersReducedMotion` 的现成范式，
 * 且 matchMedia 只在跳档时触发，拖窗口不会每帧 setState。
 */
import { useEffect, useState } from "react";

/** 侧栏常驻的门槛。 */
const WIDE = "(min-width: 600px)";
/** 第三栏的门槛。 */
const EXTRA_WIDE = "(min-width: 800px)";

function useMql(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    // 订阅前窗口可能已变（组件挂载与尺寸变化的竞态），对一次
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export interface KbLayout {
  /** ≥600px：侧栏常驻（不再默认收起） */
  sidebarPinned: boolean;
  /** ≥800px：第三栏可用，点笔记不再弹窗 */
  hasDetailPane: boolean;
}

export function useKbLayout(): KbLayout {
  const sidebarPinned = useMql(WIDE);
  const hasDetailPane = useMql(EXTRA_WIDE);
  return { sidebarPinned, hasDetailPane };
}
