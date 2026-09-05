import { useEffect, useState } from "react";

/**
 * 订阅一条媒体查询。
 *
 * 用 matchMedia 而不是监 resize：同 `usePrefersReducedMotion` 的现成范式，
 * 而且 matchMedia 只在**跳档时**触发，拖窗口不会每帧 setState。
 *
 * 原本是 `useKbLayout.ts` 里的私有函数，设置页双栏也要用，按规则 #11 收口到这里。
 */
export function useMediaQuery(query: string): boolean {
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
