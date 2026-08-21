import { useState, useEffect, useRef, lazy, Suspense, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { useToast } from "@/components/Toast";
import { CardWithContext, ImgState } from "@/components/Card";
import { useCardOcr } from "@/hooks/useCardOcr";
import type { ImageOcrState } from "@/lib/utils";
import { ContextMenu } from "@/components/ContextMenu";
import { StackBanner } from "@/components/StackBanner";
import { MdAssocBanner } from "@/components/MdAssocBanner";
import { TagEditor } from "@/components/TagEditor";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getImageThumbnail, copyItemToClipboard, deleteHistory, copyOnly, pasteTextGuarded } from "@/lib/api";
import { getAllRules } from "@/lib/regexRules";
import { errText } from "@/lib/utils";
import { thumbnailSourcePath } from "@/lib/richContent";
import { ClipboardList, Copy, Search, Zap, CheckSquare, Square, FileDown, Trash2, GitCompare, FileX, Sparkles, ClipboardPaste } from "lucide-react";
import { Timeline } from "@/components/Timeline";
import Lenis from "lenis";
import styles from "./CardList.module.css";
import melodyUrl from "@/assets/melody.png";
import { useLoadMore } from "@/hooks/useLoadMore";
import { useVirtualScroll } from "@/hooks/useVirtualScroll";
import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { ItemEditorDialog } from "@/components/editors/ItemEditorDialog";
import { MergeDialog, type MergeItem } from "@/components/MergeDialog";
import { TransformHubDialog } from "@/components/TransformHubDialog";
import { ChainRunnerDialog } from "@/components/ChainRunnerDialog";
import { ChainEditor } from "@/components/ChainEditor";
import { LearningsDialog } from "@/components/LearningsDialog";
import { ProfileDialog } from "@/components/ProfileDialog";
import { PasteGuardDialog } from "@/components/PasteGuardDialog";
import { MilestoneDialog } from "@/components/MilestoneDialog";
import { QuotaDialog } from "@/components/QuotaDialog";
import { SignFloat } from "@/components/SignFloat";
import { FreeQuotaOnboarding } from "@/components/FreeQuotaOnboarding";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const QRCodeDialog = lazy(() => import("@/components/QRCodeDialog").then(m => ({ default: m.QRCodeDialog })));
const DiffDialog = lazy(() => import("@/components/DiffDialog").then(m => ({ default: m.DiffDialog })));
const RegexPreviewDialog = lazy(() => import("@/components/RegexPreviewDialog").then(m => ({ default: m.RegexPreviewDialog })));
const RegexRulesDialog = lazy(() => import("@/components/RegexRulesDialog").then(m => ({ default: m.RegexRulesDialog })));

/** 解析 ruleId → rule 对象，再渲染 RegexPreviewDialog */
function RegexPreviewDialogWrapper({ item, ruleId, onClose }: { item: HistoryItem; ruleId: string; onClose: () => void }) {
  const rule = getAllRules().find((r) => r.id === ruleId);
  if (!rule) return null;
  return <RegexPreviewDialog text={item.text || ""} rule={rule} onClose={onClose} />;
}

/**
 * 虚拟化行（memoized）— CardList 每滚动帧因 scrollMetrics 重渲染，
 * 若行内联闭包则所有可见 Card 的 memo 全部失效。改为：行组件接收稳定的
 * by-id 回调 + 原始类型标志，浅比较通过即跳过，闭包放在行内部创建。
 */
const VirtualCardRow = memo(function VirtualCardRow({
  item, selected, pasting, imageState, searchKeyword, stackOrder, stackDone, ocrState,
  index, disablePreview, showMoveToGroup,
  onItemClick, onItemDoubleClick, onRetryImage, onEdit, onEditTags,
  onQrCode, onRegexPreview, onManageRegexRules,
}: {
  item: HistoryItem;
  selected: boolean;
  pasting: boolean;
  imageState: ImgState | undefined;
  ocrState: ImageOcrState | undefined;
  searchKeyword: string;
  stackOrder: number | undefined;
  stackDone: boolean;
  index: number;
  disablePreview: boolean;
  showMoveToGroup: boolean;
  onItemClick: (id: string, ctrl: boolean, shift: boolean) => void;
  onItemDoubleClick: (id: string) => void;
  onRetryImage: (content: string) => void;
  onEdit: (item: HistoryItem) => void;
  onEditTags: (item: HistoryItem) => void;
  onQrCode: (item: HistoryItem) => void;
  onRegexPreview: (item: HistoryItem, ruleId: string) => void;
  onManageRegexRules: () => void;
}) {
  return (
    <CardWithContext
      item={item} selected={selected}
      imageState={imageState}
      ocrState={ocrState}
      searchKeyword={searchKeyword}
      pasting={pasting}
      onRetryImage={(() => {
        const p = thumbnailSourcePath(item);
        return p && imageState?.status === "error" ? () => onRetryImage(p) : undefined;
      })()}
      onClick={(e: React.MouseEvent) => onItemClick(item.id, e.ctrlKey, e.shiftKey)}
      onDoubleClick={() => onItemDoubleClick(item.id)}
      onEdit={onEdit}
      onEditTags={onEditTags}
      onMoveToGroup={showMoveToGroup ? (it) => {
        window.dispatchEvent(new CustomEvent("app-move-to-group", { detail: { item: it } }));
      } : undefined}
      onQrCode={onQrCode}
      onRegexPreview={onRegexPreview}
      onManageRegexRules={onManageRegexRules}
      stackOrder={stackOrder}
      stackDone={stackDone}
      index={index}
      disablePreview={disablePreview}
    />
  );
});

export function CardList({ scrollRef: externalScrollRef, lenisRef: externalLenisRef, showMoveToGroup = false }: { scrollRef?: React.RefObject<HTMLDivElement | null>; lenisRef?: React.RefObject<Lenis | null>; showMoveToGroup?: boolean }) {
  const history = useAppStore((s) => s.history);
  const searchKeyword = useAppStore((s) => s.searchKeyword);
  const searchLoading = useAppStore((s) => s.searchLoading);
  const filterType = useAppStore((s) => s.filterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  // 搜索模式：关键词激活时列表数据源为后端全量搜索结果（非分页窗口），需禁用分页加载
  const searchMode = !!searchKeyword.trim();
  const hasActiveFilter = !!(
    searchKeyword ||
    filterType !== "all" ||
    timeFilter !== "all" ||
    sourceFilter !== "" ||
    groupFilter !== "all" ||
    selectedTagIds.length > 0
  );
  const clearAllFilters = useCallback(() => {
    const st = useAppStore.getState();
    st.setSearchKeyword("");
    st.setFilterType("all");
    st.setTimeFilter("all");
    st.setSourceFilter("");
    st.setGroupFilter("all");
    st.clearTagFilters();
  }, []);

  // 监听系统文件关联事件：双击 .md 文件时打开独立全屏编辑器窗口
  useEffect(() => {
    // 应用已在运行时：第二个实例的参数经 single-instance 插件 emit 事件过来
    const unlisten = listen<string[]>("file-open-event", (event) => {
      const paths = event.payload;
      if (paths.length > 0) {
        invoke("open_fullscreen_editor", { filePath: paths[0], contentType: "markdown" }).catch(() => {});
      }
    });
    // 应用未运行时双击 .md：路径在启动参数中，setup 阶段已存入 PendingFileOpen，
    // 前端挂载后主动取走（此时 emit 事件尚未注册，不能依赖事件）
    invoke<string[]>("take_pending_file_open").then((paths) => {
      if (paths.length > 0) {
        invoke("open_fullscreen_editor", { filePath: paths[0], contentType: "markdown" }).catch(() => {});
      }
    }).catch(() => { /* 命令不存在或无待打开文件时静默忽略 */ });
    return () => { unlisten.then(fn => fn()); };
  }, []);
  const getFilteredItems = useAppStore((s) => s.getFilteredItems);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const focusId = useAppStore((s) => s.focusId);
  const selectItem = useAppStore((s) => s.selectItem);

  // 剪贴板栈状态
  const stackMode = useAppStore((s) => s.stackMode);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackDoneIds = useAppStore((s) => s.stackDoneIds);
  const semanticHits = useAppStore((s) => s.semanticHits);
  const stackOrderMap = useMemo(() => {
    if (!stackMode) return null;
    const m = new Map<string, number>();
    stackItems.forEach((it, i) => {
      if (!m.has(it.id)) m.set(it.id, i + 1);
    });
    return m;
  }, [stackMode, stackItems]);

  const { toast } = useToast();
  const openEditor = useDialogStore((s) => s.openEditor);
  const editorItem = useDialogStore((s) => s.editorItem);
  const [tagEditorItem, setTagEditorItem] = useState<HistoryItem | null>(null);
  const [qrItem, setQrItem] = useState<HistoryItem | null>(null);
  const [diffPair, setDiffPair] = useState<[HistoryItem, HistoryItem] | null>(null);
  const [regexPreview, setRegexPreview] = useState<{ item: HistoryItem; ruleId: string } | null>(null);
  const [showRegexRules, setShowRegexRules] = useState(false);
  const [pastingId, setPastingId] = useState<string | null>(null);
  const [imgCache, setImgCache] = useState<Record<string, ImgState>>({});
  // 方案 C 置顶动画：gliding=行 glide 过渡窗口开关；landingId=落定高亮环目标行
  const [gliding, setGliding] = useState(false);
  const [landingId, setLandingId] = useState<string | null>(null);
  const glideTimerRef = useRef<number | null>(null);
  const landingShowTimerRef = useRef<number | null>(null);
  const landingClearTimerRef = useRef<number | null>(null);

  // ── Refs ──
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const internalLenisRef = useRef<Lenis | null>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const lenisRef = externalLenisRef ?? internalLenisRef;
  const loadedPathsRef = useRef<Set<string>>(new Set());
  const imgRetryCount = useRef<Record<string, number>>({});
  const MAX_IMG_RETRY = 2;

  // 回调 ref：同时同步到 externalScrollRef 和 internalScrollRef
  const handleScrollRef = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    if (externalScrollRef) {
      externalScrollRef.current = node;
    }
  }, [externalScrollRef]);

  // ── 统一使用 store 的过滤排序逻辑 ──
  // 下面依赖数组里那堆值看着"多余"（函数体里确实没直接引用，exhaustive-deps
  // 也就这么报），但它们是承重的：getFilteredItems() 是从 store 内部读状态的，
  // 真按 lint 建议删掉，筛选条件变化时这个 memo 就永远不重算，列表不刷新。别删。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => getFilteredItems(), [history, searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, getFilteredItems]);

  // ── 虚拟列表 ──
  // useFlushSync:false — 3.14.x 默认 true 会在滚动中 onChange 调 flushSync(rerender)，
  // 与 Lenis 逐帧派发 scroll + measureElement 动态行高组合会在 commit 阶段触发
  // "flushSync was called from inside a lifecycle method" dev 警告（TanStack/virtual#1094，
  // 上游即以此选项关闭该 issue）；本项目滚动由 Lenis 插值驱动，无需同步 flush 保证。
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 82,
    overscan: 8,
    useFlushSync: false,
    getItemKey: (i) => items[i]?.id || `vitem-${i}`,
  });

  // ── 提取的 hooks ──
  const { hasMore, loadingMore, loadError, retryCount, triggerLoadMore, handleRetryLoadMore } = useLoadMore({
    scrollRef, lenisRef, itemsLength: items.length,
    enabled: !searchMode, // 搜索模式下列表来自后端搜索结果，禁用分页加载
  });


  const {
    contentRef, scrollMetrics, isScrolling,
    timelineExpanded, setTimelineExpanded,
    timelineNodes, timelineGroupIndices, timelineHideTimerRef,
    handleScrollToIndex, handleTimelineWheel, handleDragScroll,
  } = useVirtualScroll({
    scrollRef, lenisRef, items, virtualizer,
    searchKeyword, filterType, triggerLoadMore,
  });

  // ── 弹框打开时暂停 Lenis，防止滚轮事件穿透到背景列表 ──
  const anyDialogOpen = !!(editorItem || tagEditorItem || qrItem || diffPair || regexPreview || showRegexRules);
  const anyDialogOpenRef = useRef(anyDialogOpen);
  anyDialogOpenRef.current = anyDialogOpen;
  useEffect(() => {
    const lenis = lenisRef.current;
    if (!lenis) return;
    if (anyDialogOpen) {
      lenis.stop();
    } else {
      lenis.start();
    }
  }, [anyDialogOpen, lenisRef]);

  // ── Glide 过渡窗口（置顶/删除重排共享）──
  // 置顶/删除触发 getFilteredItems 重排，行 translateY 随之变化；在重排瞬间
  // 给行挂 380ms transform 过渡（rowGlide），各行平滑让位。glide 期间暂停
  // Lenis，防止滚动回收行与过渡叠加产生重影；结束后恢复。
  const triggerGlide = useCallback(() => {
    setGliding(true);
    if (glideTimerRef.current !== null) window.clearTimeout(glideTimerRef.current);
    glideTimerRef.current = window.setTimeout(() => {
      glideTimerRef.current = null;
      setGliding(false);
    }, 450);
    const lenis = lenisRef.current;
    if (lenis) lenis.stop();
    // glide 结束后恢复 Lenis（弹框打开时保持暂停，交由 anyDialogOpen 效果管理）
    window.setTimeout(() => {
      if (lenisRef.current && !anyDialogOpenRef.current) lenisRef.current.start();
    }, 400);
  }, [lenisRef]);

  // glide 定时器卸载清理
  useEffect(() => {
    return () => {
      if (glideTimerRef.current !== null) window.clearTimeout(glideTimerRef.current);
    };
  }, []);

  // ── 方案 C 置顶动画：pin-anim 事件（lib/api togglePin 派发）──
  // glide 之外额外给目标行落定高亮环。
  useEffect(() => {
    const onPinAnim = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      triggerGlide();
      if (landingShowTimerRef.current !== null) window.clearTimeout(landingShowTimerRef.current);
      if (landingClearTimerRef.current !== null) window.clearTimeout(landingClearTimerRef.current);
      landingShowTimerRef.current = window.setTimeout(() => {
        landingShowTimerRef.current = null;
        if (id) setLandingId(id);
      }, 400);
      landingClearTimerRef.current = window.setTimeout(() => {
        landingClearTimerRef.current = null;
        setLandingId(null);
      }, 1450);
    };
    window.addEventListener("pin-anim", onPinAnim);
    return () => {
      window.removeEventListener("pin-anim", onPinAnim);
      if (landingShowTimerRef.current !== null) window.clearTimeout(landingShowTimerRef.current);
      if (landingClearTimerRef.current !== null) window.clearTimeout(landingClearTimerRef.current);
    };
  }, [triggerGlide]);

  // ── 新条目插入动画：new-anim 事件（stores/appStore prependItem 派发）──
  // 与置顶同款：先 glide 让下方行平滑让位，落定后给新条目加高亮环（rowLanding）。
  useEffect(() => {
    const onNewAnim = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      triggerGlide();
      if (landingShowTimerRef.current !== null) window.clearTimeout(landingShowTimerRef.current);
      if (landingClearTimerRef.current !== null) window.clearTimeout(landingClearTimerRef.current);
      landingShowTimerRef.current = window.setTimeout(() => {
        landingShowTimerRef.current = null;
        if (id) setLandingId(id);
      }, 400);
      landingClearTimerRef.current = window.setTimeout(() => {
        landingClearTimerRef.current = null;
        setLandingId(null);
      }, 1450);
    };
    window.addEventListener("new-anim", onNewAnim);
    return () => {
      window.removeEventListener("new-anim", onNewAnim);
      if (landingShowTimerRef.current !== null) window.clearTimeout(landingShowTimerRef.current);
      if (landingClearTimerRef.current !== null) window.clearTimeout(landingClearTimerRef.current);
    };
  }, [triggerGlide]);

  // ── 删除动画：delete-anim 事件（lib/api deleteHistory 派发）──
  // 仅需 glide（剩余行让位），无高亮环；被删行退场由 AnimatePresence 播放。
  useEffect(() => {
    const onDeleteAnim = () => triggerGlide();
    window.addEventListener("delete-anim", onDeleteAnim);
    return () => window.removeEventListener("delete-anim", onDeleteAnim);
  }, [triggerGlide]);

  // ── #5 筛选交叉淡入 ──
  // 筛选条件变化时，新结果集以快速淡入+轻位移呈现（WAAPI 直接驱动行容器）。
  // 选 WAAPI 而非 framer/React state：不引入额外渲染、不重挂载行、不与虚拟列表
  // 行内联 translateY / rowGlide 冲突（动画作用在行容器，transform 互不影响）。
  // filterKey 不含 searchKeyword：搜索有独立 loading 节奏，逐键触发会闪烁。
  const rowsWrapRef = useRef<HTMLDivElement>(null);
  const filterKey = `${filterType}|${timeFilter}|${sourceFilter}|${groupFilter}|${selectedTagIds.join(",")}`;
  const prevFilterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKeyRef.current === filterKey) return;
    prevFilterKeyRef.current = filterKey;
    // 筛选切换时滚动复位到顶部（功能性，不受动画开关影响）：
    // 否则虚拟列表沿用旧偏移渲染，缩略图窗口（thumbFirst/Last）指向错误区间，
    // 新 tab 的图片/文件不会进入可视范围、缩略图不加载。
    lenisRef.current?.scrollTo(0, { immediate: true });
    const el = rowsWrapRef.current;
    if (!el || !el.isConnected) return;
    if (!useAppStore.getState().config.window_animation) return;
    if (prefersReducedMotion()) return;
    el.animate(
      [
        { opacity: 0.15, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 260, easing: "ease-out" },
    );
  }, [filterKey, lenisRef]);

  // ── 缩略图可视窗口范围 ──
  const vItemsNow = virtualizer.getVirtualItems();
  const thumbFirst = vItemsNow.length > 0 ? vItemsNow[0].index : 0;
  const thumbLast = vItemsNow.length > 0 ? vItemsNow[vItemsNow.length - 1].index : 0;
  const thumbWindowKey = `${thumbFirst}-${thumbLast}`;

  // ── 图片条目 OCR 懒识别（可视窗口 ± 缓冲触发，结果以 item.id 为键）──
  const ocrById = useCardOcr(items, thumbFirst, thumbLast);

  // 异步加载图片缩略图（只加载可视窗口 ± 缓冲范围）
  useEffect(() => {
    // 缩略图源路径：image 类型就是 content，rich 类型取片段里第一张内嵌图
    const pathsToLoad = items
      .slice(Math.max(0, thumbFirst - 4), thumbLast + 5)
      .map((i) => thumbnailSourcePath(i))
      .filter((p): p is string => !!p && !loadedPathsRef.current.has(p));
    if (pathsToLoad.length === 0) return;

    let cancelled = false;
    const completedPaths = new Set<string>();
    pathsToLoad.forEach((p) => loadedPathsRef.current.add(p));

    const loadingStates: Record<string, ImgState> = {};
    for (const path of pathsToLoad) loadingStates[path] = { status: "loading" };
    setImgCache((prev) => ({ ...prev, ...loadingStates }));

    const CONCURRENCY = 6;
    (async () => {
      for (let i = 0; i < pathsToLoad.length; i += CONCURRENCY) {
        if (cancelled) return;
        const batch = pathsToLoad.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((path) => getImageThumbnail(path))
        );
        if (cancelled) return;
        const updates: Record<string, ImgState> = {};
        batch.forEach((path, idx) => {
          const result = results[idx];
          if (result.status === "fulfilled" && result.value) {
            updates[path] = { status: "loaded", url: result.value };
            completedPaths.add(path);
          } else {
            const retries = (imgRetryCount.current[path] || 0) + 1;
            imgRetryCount.current[path] = retries;
            updates[path] = retries > MAX_IMG_RETRY ? { status: "silent" } : { status: "error" };
            completedPaths.add(path);
          }
        });
        setImgCache((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
      for (const p of pathsToLoad) {
        if (!completedPaths.has(p)) {
          // lint 会提醒"cleanup 里读 ref.current 可能已经变了，建议先拷到局部变量"——
          // 这里恰恰就要 cleanup 时刻的那个 Set：目的是把没加载完的路径从"已加载"
          // 登记表里摘掉好让它重试。按建议拷贝反而拿到旧 Set，行为就错了。
          // eslint-disable-next-line react-hooks/exhaustive-deps
          loadedPathsRef.current.delete(p);
        }
      }
      setImgCache((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const p of pathsToLoad) {
          if (!completedPaths.has(p) && next[p]?.status === "loading") {
            delete next[p];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, thumbWindowKey]);

  // 当 items 变化时，清理 loadedPathsRef 中不再可见的路径
  useEffect(() => {
    const visiblePaths = new Set(
      items.map((i) => thumbnailSourcePath(i)).filter((p): p is string => !!p)
    );
    for (const p of loadedPathsRef.current) {
      if (!visiblePaths.has(p)) loadedPathsRef.current.delete(p);
    }
    setImgCache((prev) => {
      const cleaned: Record<string, ImgState> = {};
      for (const key of Object.keys(prev)) {
        if (visiblePaths.has(key)) cleaned[key] = prev[key];
      }
      if (Object.keys(cleaned).length === Object.keys(prev).length) return prev;
      return cleaned;
    });
  }, [items]);

  const handleRetryImage = useCallback((content: string) => {
    const retries = (imgRetryCount.current[content] || 0) + 1;
    imgRetryCount.current[content] = retries;
    loadedPathsRef.current.add(content);
    if (retries > MAX_IMG_RETRY) {
      setImgCache((prev) => ({ ...prev, [content]: { status: "silent" } }));
      return;
    }
    setImgCache((prev) => ({ ...prev, [content]: { status: "loading" } }));
    getImageThumbnail(content).then((dataUrl) => {
      setImgCache((prev) => ({ ...prev, [content]: dataUrl ? { status: "loaded", url: dataUrl } : { status: "error" } }));
    }).catch(() => setImgCache((prev) => ({ ...prev, [content]: { status: "error" } })));
  }, []);

  const handleDoubleClick = useCallback(async (item: HistoryItem) => {
    // 文件类型没有“双击复制”语义，一律开详情（保持原有行为）
    if (item.type === "file") {
      openEditor(item);
      return;
    }
    const action = useAppStore.getState().config.double_click_action || "preview";
    if (action !== "copy") {
      openEditor(item);
      return;
    }
    // 复制走统一分派（图片/图文/纯文本），不再按类型各写一份
    setPastingId(item.id);
    try {
      toast(await copyItemToClipboard(item), "success");
    } catch {
      toast("复制失败", "error");
    } finally {
      setPastingId(null);
    }
  }, [toast, openEditor]);

  // ── 稳定行回调（供 memoized VirtualCardRow 使用）──
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handleItemClick = useCallback((id: string, ctrl: boolean, shift: boolean) => {
    selectItem(id, ctrl, shift);
  }, [selectItem]);
  const handleItemDoubleClick = useCallback((id: string) => {
    const it = itemsRef.current.find((i) => i.id === id);
    if (it) handleDoubleClick(it);
  }, [handleDoubleClick]);
  const handleEditItem = useCallback((it: HistoryItem) => openEditor(it), [openEditor]);
  const handleEditTagsItem = useCallback((it: HistoryItem) => setTagEditorItem(it), []);
  const handleQrItem = useCallback((it: HistoryItem) => setQrItem(it), []);
  const handleRegexPreviewItem = useCallback((it: HistoryItem, ruleId: string) => setRegexPreview({ item: it, ruleId }), []);
  const handleManageRegexRules = useCallback(() => setShowRegexRules(true), []);

  // ── 批量操作 ──
  // v6.4 C 合并粘贴：非空 = 打开合并面板
  const [mergeItems, setMergeItems] = useState<MergeItem[] | null>(null);

  const handleBatchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const n = await deleteHistory(ids);
      if (n === 0) {
        // 审查：后端失败/未删时给反馈（此前静默，用户以为删了）
        window.dispatchEvent(
          new CustomEvent("app-toast", { detail: { message: "删除失败，请重试", type: "error" } })
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.dispatchEvent(
        new CustomEvent("app-toast", { detail: { message: `删除失败：${msg}`, type: "error" } })
      );
    }
  }, [selectedIds]);

  const handleBatchExport = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const selectedItems = items.filter((i) => ids.includes(i.id));
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, JSON.stringify(selectedItems, null, 2));
        toast(`已导出 ${selectedItems.length} 条记录`, "success");
      }
    } catch (e) {
      // 不能把真实原因吞掉：fs 权限不足、路径被占用这些靠「导出失败」四个字根本查不出来
      toast("导出失败：" + errText(e, "未知错误"), "error");
    }
  }, [selectedIds, items, toast]);

  const selectedCount = items.filter((i) => selectedIds.has(i.id)).length;

  // ── 时间轴设置 ──
  const timelineEnabled = useAppStore((s) => s.config.timeline_enabled);
  const sequentialHotkey = useAppStore((s) => s.config.sequential_hotkey);
  const theme = useAppStore((s) => s.config.theme);

  // U44：Space 快速预览 — 图片/文件项打开对应详情窗（P3 起统一走 openEditor）
  useEffect(() => {
    const onOpenItemDetail = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      const item = items.find((i) => i.id === id);
      if (!item) return;
      if ((item.type === "image" && item.content) || item.type === "file") {
        openEditor(item);
      }
    };
    window.addEventListener("app-open-item-detail", onOpenItemDetail);
    return () => window.removeEventListener("app-open-item-detail", onOpenItemDetail);
  }, [items, openEditor]);

  return (
    <ContextMenu>
    <div className={`${styles.contentArea} ${timelineExpanded ? styles.contentAreaOverflowVisible : ""}`}>
      {timelineEnabled && (
        <Timeline
          visible={timelineEnabled}
          scrollHeight={scrollMetrics.scrollHeight}
          clientHeight={scrollMetrics.clientHeight}
          scrollTop={scrollMetrics.scrollTop}
          nodes={timelineNodes}
          groupIndices={timelineGroupIndices}
          onScrollToIndex={handleScrollToIndex}
          onDragScroll={handleDragScroll}
          onWheelScroll={handleTimelineWheel}
          scrollRef={scrollRef}
          onExpandChange={setTimelineExpanded}
          onTriggerEnter={() => {
            if (timelineHideTimerRef.current) window.clearTimeout(timelineHideTimerRef.current);
          }}
          onTimelineLeave={() => {
          }}
        />
      )}

      <StackBanner />

      <MdAssocBanner />

      <div
        className={`${styles.scrollArea} ${timelineExpanded ? styles.scrollAreaTimelineVisible : ""}`}
        ref={handleScrollRef}
        role="listbox"
        aria-label="剪贴板记录列表"
        aria-multiselectable="true"
        aria-setsize={items.length}
      >
        <div ref={contentRef} className={styles.cardList}>
        <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>
          {items.length === 0 ? "没有符合条件的记录" : `共 ${items.length} 条记录`}
        </div>
        {/* M5-2 语义命中：按"意思"搜到的历史（开关开启时），展示在关键词结果上方 */}
        {searchMode && semanticHits.length > 0 && (
          <div className={styles.semanticHits}>
            <div className={styles.semanticHitsTitle}>
              <Sparkles size={12} /> 语义命中
              <span className={styles.semanticHitsCount}>
                {semanticHits.length} 条 · 按意思匹配，非关键词
              </span>
            </div>
            {semanticHits.map((h) => (
              <div key={h.historyId} className={styles.semanticHit}>
                <div className={styles.semanticHitHead}>
                  <span className={styles.semanticHitScore}>{Math.round(h.score * 100)}% 相似</span>
                  <span className={styles.semanticHitTime}>{h.createdAt}</span>
                </div>
                <div className={styles.semanticHitText}>{h.summary || h.text}</div>
                <div className={styles.semanticHitActions}>
                  <button
                    className={styles.semanticHitBtn}
                    onClick={() => void copyOnly(h.text)}
                    title="复制全文"
                  >
                    <Copy size={11} /> 复制
                  </button>
                  <button
                    className={styles.semanticHitBtn}
                    onClick={() => {
                      // 修复（v6.15）：这条路径之前完全没记粘贴信号，
                      // 于是从语义搜索里找到并用上的内容，在「按价值豁免清理」看来等于从未被用过。
                      void (async () => {
                        const ok = await pasteTextGuarded(h.text);
                        if (!ok) return;
                        // semanticHits 只带 historyId/score/summary，没有 content_type 与 source，
                        // 回到 history 里补；拿不到（已分页刷出去）就传空串，宁可少一个维度也要把价值信号记上。
                        const it = useAppStore.getState().history.find((x) => x.id === h.historyId);
                        const { logPasteEvent } = await import("@/lib/api/actionEvents");
                        // 下标传 -1：这是**搜出来的**不是列表里浏览到的。
                        // -1 的占比本身就是“搜索 vs 浏览”的比例，对判定 X3 同样有用。
                        logPasteEvent(h.historyId, it?.content_type || it?.type || "", it?.source || "", -1);
                      })();
                    }}
                    title="粘贴到前台应用"
                  >
                    <ClipboardPaste size={11} /> 粘贴
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* #6 列表 ⇄ 空状态切换：mode="wait" 先退场再入场，避免两分支同时占位跳动；
            initial={false} 保证应用首屏（空剪贴板/已有记录）不做入场动画 */}
        <AnimatePresence mode="wait" initial={false}>
        {items.length === 0 ? (
          <motion.div
            key="empty"
            className={styles.stateSwap}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease: "easeIn" } }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
          {searchMode && searchLoading ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIconWrap}>
                <span className={styles.loadMoreSpinner} />
              </div>
              <div style={{ textAlign: "center" }}>
                <p className={styles.emptyTitle}>搜索中…</p>
                <p className={styles.emptyDesc}>正在全量检索 “{searchKeyword}”</p>
              </div>
            </div>
          ) : (
          <div className={styles.emptyState}>
            {theme === "blossom" && !searchKeyword && !hasActiveFilter ? (
              <img className={styles.emptyMelody} src={melodyUrl} alt="" draggable={false} />
            ) : (
            <div className={styles.emptyIconWrap}>
              <div className={styles.emptyRing} />
              <div className={styles.emptyIcon}>
                {/* 图标压在 .emptyIcon 的 accent-light 底上，浅色主题下对比度不足 4.5:1，改用加深版 --accent-strong */}
                {searchKeyword ? (
                  <Search size={28} style={{ color: "var(--accent-strong)" }} strokeWidth={1.5} />
                ) : hasActiveFilter ? (
                  <FileX size={28} style={{ color: "var(--accent-strong)" }} strokeWidth={1.5} />
                ) : (
                  <ClipboardList size={28} style={{ color: "var(--accent-strong)" }} strokeWidth={1.5} />
                )}
              </div>
            </div>
            )}
            <div style={{ textAlign: "center" }}>
              <p className={styles.emptyTitle}>
                {searchKeyword
                  ? `没有找到 "${searchKeyword}" 的相关记录`
                  : hasActiveFilter
                    ? "没有符合条件的记录"
                    : theme === "blossom"
                      ? "剪贴板空空的～"
                      : "剪贴板是空的"}
              </p>
              <p className={styles.emptyDesc}>
                {searchKeyword
                  ? "试试调整关键词，或检查拼写是否正确"
                  : hasActiveFilter
                    ? "当前筛选条件下没有匹配的记录，试试放宽部分条件"
                    : theme === "blossom"
                      ? "复制任意内容，美乐蒂帮你收着 💗"
                      : "复制任意内容，它会自动出现在这里"}
              </p>
              {hasActiveFilter && (
                <div className={styles.emptyActions}>
                  {searchKeyword && (
                    <button onClick={() => useAppStore.getState().setSearchKeyword("")} className={styles.emptyClearBtn}>
                      清除搜索条件
                    </button>
                  )}
                  <button onClick={clearAllFilters} className={styles.emptyPrimaryBtn}>
                    清除全部筛选
                  </button>
                </div>
              )}
            </div>
            {!hasActiveFilter && (
              <div className={styles.guideCards}>
                <div className={styles.guideWelcome}>
                  <span className={styles.guideWelcomeEmoji}>👋</span>
                  <span>你的剪贴板助手已就绪，试试复制一段文字吧</span>
                </div>
                {/* 图标压在 guideIcon 的 accent-light 底上，浅色主题下对比度不足 4.5:1，改用加深版 --accent-strong */}
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Copy size={18} style={{ color: "var(--accent-strong)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>自动记录</div><div className={styles.guideDesc}>Ctrl+C 复制内容自动保存</div></div>
                </div>
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Search size={18} style={{ color: "var(--accent-strong)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>搜索查找</div><div className={styles.guideDesc}>输入关键词快速定位</div></div>
                </div>
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Zap size={18} style={{ color: "var(--accent-strong)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>依次粘贴</div><div className={styles.guideDesc}>{sequentialHotkey || "ctrl+alt+q"} 逐条粘贴</div></div>
                </div>
                <div className={styles.guideFooterHint}>
                  💡 按 <kbd>?</kbd> 查看所有快捷键 · 点击右上角 <span style={{ color: "var(--accent)" }}>⚙</span> 打开设置 → 帮助
                </div>
              </div>
            )}
          </div>
          )}
          </motion.div>
        ) : (
          <motion.div
            key="list"
            className={styles.stateSwap}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {/* 批量操作工具栏 */}
            {selectedCount > 0 && (
              <div className={styles.batchToolbar}>
                <span className={styles.batchToolbarLabel}>已选 {selectedCount} 条</span>
                <button
                  onClick={() => {
                    const store = useAppStore.getState();
                    if (selectedCount >= items.length) {
                      store.clearSelection();
                    } else {
                      store.selectAll();
                    }
                  }}
                  className={styles.batchBtn}
                  title={selectedCount >= items.length ? "取消全选" : "全选当前列表"}
                  aria-label={selectedCount >= items.length ? "取消全选" : "全选"}>
                  {selectedCount >= items.length ? <CheckSquare size={12} /> : <Square size={12} />}
                  {selectedCount >= items.length ? "取消全选" : "全选"}
                </button>
                <button
                  onClick={() => {
                    const textItems = items
                      .filter((i) => selectedIds.has(i.id) && i.type === "text" && i.text?.trim())
                      .map((i) => ({ id: i.id, text: i.text! }));
                    if (textItems.length === 0) {
                      toast("选中的记录中没有文本内容", "info");
                      return;
                    }
                    setMergeItems(textItems); // v6.4 C 合并面板
                  }}
                  className={styles.batchBtn}
                  title="合并选中文本（分隔符/编号/预览后粘贴）"
                  aria-label="合并粘贴">
                  <Copy size={12} /> 合并
                </button>
                <button onClick={handleBatchExport} className={styles.batchBtn} title="导出选中记录" aria-label="导出选中记录">
                  <FileDown size={12} /> 导出
                </button>
                <button
                  onClick={() => {
                    const selected = items.filter((i) => selectedIds.has(i.id) && i.type === "text");
                    if (selected.length === 2) {
                      const [a, b] = selected.sort((x, y) => x.time.localeCompare(y.time));
                      setDiffPair([a, b]);
                    }
                  }}
                  className={styles.batchBtn}
                  disabled={items.filter((i) => selectedIds.has(i.id) && i.type === "text").length !== 2}
                  title="对比两条文本差异（需选中恰好 2 条文本）"
                  aria-label="对比差异">
                  <GitCompare size={12} /> 对比
                </button>
                <button onClick={() => { void handleBatchDelete(); }} className={`${styles.batchBtn} ${styles.batchBtnDanger}`} title="删除选中记录（Ctrl+Z 可撤销）" aria-label="删除选中记录">
                  <Trash2 size={12} /> 删除
                </button>
              </div>
            )}
            <div ref={rowsWrapRef} style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
              {/* AnimatePresence 包裹虚拟行：删除时行被暂时保留到退场动画结束再卸载，
                  触发 Card 内 motion 元素的 exit（opacity/x/scale）；剩余行由 rowGlide 让位。
                  initial 保持默认，不影响首屏 stagger 入场 */}
              <AnimatePresence>
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = items[vItem.index];
                if (!item) return null;
                return (
                  <div key={item.id} data-index={vItem.index} data-item-id={item.id} ref={virtualizer.measureElement}
                    className={[gliding && styles.rowGlide, landingId === item.id && styles.rowLanding].filter(Boolean).join(" ")}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vItem.start}px)` }}>
                      <VirtualCardRow
                        item={item} selected={focusId === item.id || selectedIds.has(item.id)}
                        imageState={(() => {
                          const p = thumbnailSourcePath(item);
                          return p ? imgCache[p] : undefined;
                        })()}
                        ocrState={ocrById[item.id]}
                        searchKeyword={searchKeyword}
                        pasting={pastingId === item.id}
                        onItemClick={handleItemClick}
                        onItemDoubleClick={handleItemDoubleClick}
                        onRetryImage={handleRetryImage}
                        onEdit={handleEditItem}
                        onEditTags={handleEditTagsItem}
                        onQrCode={handleQrItem}
                        onRegexPreview={handleRegexPreviewItem}
                        onManageRegexRules={handleManageRegexRules}
                        showMoveToGroup={showMoveToGroup}
                        stackOrder={stackOrderMap?.get(item.id)}
                        stackDone={stackMode && stackDoneIds.has(item.id) && !stackOrderMap?.has(item.id)}
                        index={vItem.index}
                        disablePreview={isScrolling || selectedCount > 0}
                      />
                  </div>
                );
              })}
              </AnimatePresence>
            </div>
            {items.length > 0 && (
              <div className={styles.loadMoreArea}>
                {searchMode ? (
                  searchLoading ? (
                    <>
                      <span className={styles.loadMoreSpinner} />
                      <span className={styles.loadMoreHint}>搜索中…</span>
                    </>
                  ) : (
                    <span className={styles.loadMoreHint}>— 找到 {items.length} 条相关记录 —</span>
                  )
                ) : (
                  <>
                    {loadingMore && (
                      <>
                        <span className={styles.loadMoreSpinner} />
                        <span className={styles.loadMoreHint}>加载中…</span>
                      </>
                    )}
                    {loadError && !loadingMore && (
                      <>
                        <span className={styles.loadMoreError}>加载失败{retryCount > 0 ? ` (已重试 ${retryCount} 次)` : ""}</span>
                        <button onClick={handleRetryLoadMore} className={styles.loadMoreRetryBtn}>重试</button>
                      </>
                    )}
                    {!hasMore && !loadingMore && !loadError && (
                      <span className={styles.loadMoreHint}>— 已加载全部记录 —</span>
                    )}
                  </>
                )}
              </div>
            )}
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* 弹窗 —— createPortal 到 body：
          .scrollArea 的 isolation:isolate 会形成层叠上下文，内联弹窗的
          z-modal 令牌被降维到 scrollArea 内部，导致 FAB/Timeline/BackToTop
          等浮动元素盖住弹窗遮罩。Portal 到 body 后 z-index 在全局层级竞争。
          （与 ConfirmDialog / UpdateNotesDialog 的既有做法一致） */}
      {createPortal(
        <>
          <ItemEditorDialog />
          <TransformHubDialog />
          <ChainRunnerDialog />
          <ChainEditor />
          <LearningsDialog />
          <ProfileDialog />
          <PasteGuardDialog />
          <MilestoneDialog />
          <QuotaDialog />
          <SignFloat />
          <FreeQuotaOnboarding />
          {/* AnimatePresence 包裹条件挂载：关闭时子树保留到退场动画结束再卸载。
              各弹框组件内部不再自带 AnimatePresence（会形成独立 presence 边界、
              屏蔽外层退出信号），motion 元素直接参与本层 presence */}
          <AnimatePresence>
            {qrItem && (
              <Suspense key="qr-dialog" fallback={null}>
                <ErrorBoundary fallback={null}><QRCodeDialog text={qrItem.text} onClose={() => setQrItem(null)} /></ErrorBoundary>
              </Suspense>
            )}
            {diffPair && (
              <Suspense key="diff-dialog" fallback={null}>
                <ErrorBoundary fallback={null}><DiffDialog oldItem={diffPair[0]} newItem={diffPair[1]} onClose={() => setDiffPair(null)} /></ErrorBoundary>
              </Suspense>
            )}
            {regexPreview && (
              <Suspense key="regex-preview-dialog" fallback={null}>
                <ErrorBoundary fallback={null}><RegexPreviewDialogWrapper item={regexPreview.item} ruleId={regexPreview.ruleId} onClose={() => setRegexPreview(null)} /></ErrorBoundary>
              </Suspense>
            )}
            {showRegexRules && (
              <Suspense key="regex-rules-dialog" fallback={null}>
                <ErrorBoundary fallback={null}><RegexRulesDialog onClose={() => setShowRegexRules(false)} /></ErrorBoundary>
              </Suspense>
            )}
            {/* v6.4 C 合并粘贴面板 */}
            {mergeItems && (
              <MergeDialog items={mergeItems} onClose={() => setMergeItems(null)} />
            )}
          </AnimatePresence>
          <TagEditor open={!!tagEditorItem} item={tagEditorItem} onClose={() => setTagEditorItem(null)} />
        </>,
        document.body
      )}

    </div>
    </div>
    </ContextMenu>
  );
}
