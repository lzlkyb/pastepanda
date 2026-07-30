/**
 * useLoadMore — 分页加载逻辑（从 CardList.tsx 提取）
 *
 * 管理：hasMore / loadingMore / loadError / retryCount 状态，
 * 防重入锁 + 冷却期，以及首屏不满时自动加载。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import type Lenis from "lenis";
import { loadMoreHistory } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

/** 单次筛选下自动补载的页数上限（每页 50 条 ≈ 1500 条），防止永不填满的死循环 */
const MAX_AUTOFILL_PAGES = 30;

export interface UseLoadMoreOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lenisRef: React.RefObject<Lenis | null>;
  itemsLength: number;
  /** 是否启用分页加载（搜索模式下列表来自后端搜索结果，需禁用，默认 true） */
  enabled?: boolean;
}

export interface UseLoadMoreReturn {
  hasMore: boolean;
  loadingMore: boolean;
  loadError: boolean;
  retryCount: number;
  triggerLoadMore: () => void;
  handleRetryLoadMore: () => void;
}

export function useLoadMore({ scrollRef, lenisRef, itemsLength, enabled = true }: UseLoadMoreOptions): UseLoadMoreReturn {
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // enabled 放入 ref：triggerLoadMore 等稳定回调读取最新值，避免闭包过期
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // setHistory（初始化/导入/切换工作区等整体替换）会自增 historyResetSeq，
  // 此时历史窗口被重建，需重置 hasMore 让分页重新武装（否则导入后卡在旧状态）
  const historyResetSeq = useAppStore((s) => s.historyResetSeq);
  useEffect(() => {
    setHasMore(true);
    setLoadError(false);
    initLoadRef.current = false;
    autoFillAttemptsRef.current = 0;
  }, [historyResetSeq]);

  // tab/筛选切换不走 setHistory（无 historyResetSeq 自增），须单独重置补载闸门：
  // 否则首个 tab 补载完成后，切到稀疏 tab（图片/文件等）不再自动加载更多。
  const filterType = useAppStore((s) => s.filterType);
  useEffect(() => {
    initLoadRef.current = false;
    autoFillAttemptsRef.current = 0;
  }, [filterType]);

  // 滚动到底部时加载更多（通过 ref 在 Lenis scroll 回调中触发，避免闭包过期问题）
  const loadMoreRef = useRef({ hasMore, loadingMore });
  loadMoreRef.current = { hasMore, loadingMore };

  // 纯 ref 防重入锁：在 then/catch 中解锁，保证同一时间只有一个加载请求
  const loadingLockRef = useRef(false);
  // 加载冷却期：加载完成后 500ms 内不再触发，解决 Lenis 渐进滚动多帧触发问题
  const loadCooldownRef = useRef(0);

  // 自动补载闸门：false = 允许"不满一屏则加载更多"检测；填满（或放弃）后置 true，
  // 交给 Lenis 滚动回调的触底加载。historyResetSeq / filterType 变化时重置回 false。
  const initLoadRef = useRef(false);
  // 一次筛选下自动补载的连续页数计数（随闸门重置），设上限防止永不填满的病态死循环
  const autoFillAttemptsRef = useRef(0);

  const triggerLoadMore = useCallback(() => {
    // 分页被禁用（搜索模式）时不触发
    if (!enabledRef.current) return;
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
    if (!enabledRef.current) return;
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

  // 自动补载：内容不满一屏时循环加载更多直到填满可视区、全部加载完或达到页数上限。
  // 用 handleRetryLoadMore 而非 triggerLoadMore：后者有 Lenis 触底检测 + 500ms 冷却，
  // 补载循环里内容始终不满屏（lenis.limit≈0），冷却会卡死循环。
  // 守禁用 historyLength（已加载窗口总量）而非 itemsLength（筛选后数量）：
  // 稀疏 tab 筛选结果为 0 恰恰是需要继续加载的时候，仅初始挂载时 historyLength===0。
  const historyLength = useAppStore((s) => s.history.length);
  useEffect(() => {
    if (!enabledRef.current || initLoadRef.current || historyLength === 0 || !hasMore || loadingMore || loadingLockRef.current) return;
    // 延迟一帧等 Lenis / 虚拟列表布局完成
    const timer = setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight + 10) {
        // 内容不足以产生滚动条 → 继续加载（计入补载次数，超限则放弃）
        if (autoFillAttemptsRef.current >= MAX_AUTOFILL_PAGES) {
          initLoadRef.current = true;
          return;
        }
        autoFillAttemptsRef.current += 1;
        handleRetryLoadMore();
      } else {
        // 已填满可视区，闸门关闭，后续交给 Lenis scroll 回调的触底加载
        initLoadRef.current = true;
      }
    }, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsLength, hasMore, loadingMore, filterType, historyLength, handleRetryLoadMore]);

  return { hasMore, loadingMore, loadError, retryCount, triggerLoadMore, handleRetryLoadMore };
}
