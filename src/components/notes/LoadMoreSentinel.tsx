/**
 * 滚到底自动拉下一页（B2 #9 的前置）。
 *
 * **为何必需**：改之前笔记列表只拉 `PAGE = 50` 一页、既无翻页也无加载更多，
 * 而面包屑上的「· N 条」用的是真实总数——超过 50 条时面包屑说 60、列表只给 50，
 * 没任何提示（同 A-32 那个「横幅 225 / 列表 200」）。
 * 排序与分组建立在一个被悄悄切掉的子集上，比没有更糟，所以这一步必须先做。
 *
 * 用 IntersectionObserver 而不是监 scroll：不用自己算滚动位置，也不靠轮询。
 * `root: null`（视口）在内部滚动容器里也能工作：哨兵被容器裁掉时就不与视口相交。
 *
 * 🔴 红线：纯展示层，无 AI。
 */
import { useEffect, useRef } from "react";

export function LoadMoreSentinel({
  hasMore,
  loading,
  onLoadMore,
  className,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 用 ref 存回调：否则父组件每次重渲染都会重建 observer，
  // 而重建的瞬间会再触发一次相交回调 → 重复拉同一页。
  const cbRef = useRef(onLoadMore);
  cbRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore || loading) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cbRef.current();
      },
      // 提前 200px 开始拉：真滚到底才拉会看到一段空白
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading]);

  if (!hasMore) return null;
  return (
    <div ref={ref} className={className}>
      {loading ? "加载中…" : "滚动加载更多"}
    </div>
  );
}
