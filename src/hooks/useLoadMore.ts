/**
 * useLoadMore — 分页加载逻辑（从 CardList.tsx 提取）
 *
 * 管理：hasMore / loadingMore / loadError / retryCount 状态，
 * 防重入锁 + 冷却期，以及首屏不满时自动加载。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import type Lenis from "lenis";
import { loadMoreHistory } from "@/lib/api";

export interface UseLoadMoreOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lenisRef: React.RefObject<Lenis | null>;
  itemsLength: number;
}

export interface UseLoadMoreReturn {
  hasMore: boolean;
  loadingMore: boolean;
  loadError: boolean;
  retryCount: number;
  triggerLoadMore: () => void;
  handleRetryLoadMore: () => void;
}

export function useLoadMore({ scrollRef, lenisRef, itemsLength }: UseLoadMoreOptions): UseLoadMoreReturn {
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // 滚动到底部时加载更多（通过 ref 在 Lenis scroll 回调中触发，避免闭包过期问题）
  const loadMoreRef = useRef({ hasMore, loadingMore });
  loadMoreRef.current = { hasMore, loadingMore };

  // 纯 ref 防重入锁：在 then/catch 中解锁，保证同一时间只有一个加载请求
  const loadingLockRef = useRef(false);
  // 加载冷却期：加载完成后 500ms 内不再触发，解决 Lenis 渐进滚动多帧触发问题
  const loadCooldownRef = useRef(0);

  const triggerLoadMore = useCallback(() => {
    // 冷却期内不触发（解决 Lenis 渐进滚动多帧触发）
    if (Date.now() < loadCooldownRef.current) return;
    // 防重入：锁住或 state 已标记加载中时直接返回
    if (loadingLockRef.current) return;
    const { hasMore: hm, loadingMore: lm } = loadMoreRef.current;
    if (!hm || lm) return;
    const lenis = lenisRef.current;
    if (!lenis) return;
    // 用 Lenis 内部状态做触底检测（Lenis 接管滚动后 wrapper.scrollTop 始终为 0）
    const threshold = 80;
    const scrollPos = lenis.scroll;     // Lenis 虚拟滚动位置
    const maxScroll = lenis.limit;      // 最大可滚动距离
    if (maxScroll - scrollPos < threshold) {
      // 先设锁，再设 state（state 异步更新，锁同步生效）
      loadingLockRef.current = true;
      setLoadingMore(true);
      setLoadError(false);
      loadMoreHistory().then((more) => {
        setHasMore(more);
        setLoadingMore(false);
        setRetryCount(0);
        loadingLockRef.current = false;
        // 加载成功后进入 500ms 冷却期，防止 Lenis 继续滚动到底部再次触发
        loadCooldownRef.current = Date.now() + 500;
      }).catch(() => {
        setLoadingMore(false);
        setLoadError(true);
        loadingLockRef.current = false;
        // 失败也进入冷却期，避免快速重试
        loadCooldownRef.current = Date.now() + 500;
      });
    }
  }, []);

  // 手动重试加载
  const handleRetryLoadMore = useCallback(() => {
    if (loadingLockRef.current || loadingMore) return;
    loadingLockRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    loadMoreHistory().then((more) => {
      setHasMore(more);
      setLoadingMore(false);
      setRetryCount(0);
      loadingLockRef.current = false;
      loadCooldownRef.current = Date.now() + 500;
    }).catch(() => {
      setLoadingMore(false);
      setLoadError(true);
      setRetryCount((c) => c + 1);
      loadingLockRef.current = false;
      loadCooldownRef.current = Date.now() + 500;
    });
  }, [loadingMore]);

  // 初始化后自动检测：内容不满一屏时，主动加载更多直到填满或全部加载完
  // 只尝试一次，由 Lenis 回调的 triggerLoadMore 接管后续触底加载
  const initLoadRef = useRef(false);
  useEffect(() => {
    if (initLoadRef.current || itemsLength === 0 || !hasMore || loadingMore || loadingLockRef.current || Date.now() < loadCooldownRef.current) return;
    // 延迟一帧等 Lenis 初始化完成
    const timer = setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      // 内容不足以产生滚动条 → 自动加载更多（只触发一次）
      if (el.scrollHeight <= el.clientHeight + 10) {
        triggerLoadMore();
      }
      // 无论是否触发加载，标记完成（后续由 scroll 回调负责触底加载）
      initLoadRef.current = true;
    }, 100);
    return () => clearTimeout(timer);
  }, [itemsLength, hasMore, loadingMore]);

  return { hasMore, loadingMore, loadError, retryCount, triggerLoadMore, handleRetryLoadMore };
}
