import { useState, useEffect, useRef, lazy, Suspense, useCallback, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { useToast } from "@/components/Toast";
import { CardWithContext, ImgState } from "@/components/Card";
import { ContextMenu } from "@/components/ContextMenu";
import { StackBanner } from "@/components/StackBanner";
import { TagEditor } from "@/components/TagEditor";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { pasteText, pasteImage, getImageThumbnail, getImageBase64, dataUrlToBlob, deleteHistory } from "@/lib/api";
import { getAllRules } from "@/lib/regexRules";
import { ClipboardList, Copy, Search, Zap, CheckSquare, Square, FileDown, Trash2, GitCompare, FileX } from "lucide-react";
import { Timeline } from "@/components/Timeline";
import Lenis from "lenis";
import styles from "./CardList.module.css";
import { useLoadMore } from "@/hooks/useLoadMore";
import { useVirtualScroll } from "@/hooks/useVirtualScroll";
import { ItemEditorDialog } from "@/components/editors/ItemEditorDialog";

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
  item, selected, pasting, imageState, searchKeyword, stackOrder, stackDone,
  index, disablePreview, showMoveToGroup,
  onItemClick, onItemDoubleClick, onRetryImage, onEdit, onEditTags,
  onQrCode, onRegexPreview, onManageRegexRules,
}: {
  item: HistoryItem;
  selected: boolean;
  pasting: boolean;
  imageState: ImgState | undefined;
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
      searchKeyword={searchKeyword}
      pasting={pasting}
      onRetryImage={item.type === "image" && item.content && imageState?.status === "error"
        ? () => onRetryImage(item.content) : undefined}
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
  const filterType = useAppStore((s) => s.filterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
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
  const getFilteredItems = useAppStore((s) => s.getFilteredItems);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const focusId = useAppStore((s) => s.focusId);
  const selectItem = useAppStore((s) => s.selectItem);

  // 剪贴板栈状态
  const stackMode = useAppStore((s) => s.stackMode);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackDoneIds = useAppStore((s) => s.stackDoneIds);
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
  const [tagEditorItem, setTagEditorItem] = useState<HistoryItem | null>(null);
  const [qrItem, setQrItem] = useState<HistoryItem | null>(null);
  const [diffPair, setDiffPair] = useState<[HistoryItem, HistoryItem] | null>(null);
  const [regexPreview, setRegexPreview] = useState<{ item: HistoryItem; ruleId: string } | null>(null);
  const [showRegexRules, setShowRegexRules] = useState(false);
  const [pastingId, setPastingId] = useState<string | null>(null);
  const [imgCache, setImgCache] = useState<Record<string, ImgState>>({});

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
  const items = useMemo(() => getFilteredItems(), [history, searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, getFilteredItems]);

  // ── 虚拟列表 ──
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 82,
    overscan: 8,
    getItemKey: (i) => items[i]?.id || `vitem-${i}`,
  });

  // ── 提取的 hooks ──
  const { hasMore, loadingMore, loadError, retryCount, triggerLoadMore, handleRetryLoadMore } = useLoadMore({
    scrollRef, lenisRef, itemsLength: items.length,
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

  // ── 缩略图可视窗口范围 ──
  const vItemsNow = virtualizer.getVirtualItems();
  const thumbFirst = vItemsNow.length > 0 ? vItemsNow[0].index : 0;
  const thumbLast = vItemsNow.length > 0 ? vItemsNow[vItemsNow.length - 1].index : 0;
  const thumbWindowKey = `${thumbFirst}-${thumbLast}`;

  // 异步加载图片缩略图（只加载可视窗口 ± 缓冲范围）
  useEffect(() => {
    const imageItems = items
      .slice(Math.max(0, thumbFirst - 4), thumbLast + 5)
      .filter(
        (i) => i.type === "image" && i.content && !loadedPathsRef.current.has(i.content)
      );
    if (imageItems.length === 0) return;

    let cancelled = false;
    const completedPaths = new Set<string>();
    const pathsToLoad = imageItems.map((i) => i.content!);
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
    const visiblePaths = new Set(items.filter((i) => i.type === "image" && i.content).map((i) => i.content!));
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
    if (item.type === "image" && item.content) {
      const action = useAppStore.getState().config.double_click_action || "preview";
      if (action === "copy") {
        setPastingId(item.id);
        try {
          const dataUrl = await getImageBase64(item.content);
          const blob = await dataUrlToBlob(dataUrl);
          const mimeType = blob.type || "image/png";
          await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
          toast("图片已复制", "success");
        } catch {
          toast("复制图片失败", "error");
        } finally {
          setPastingId(null);
        }
      } else {
        openEditor(item);
      }
    } else if (item.type === "file") {
      openEditor(item);
    } else if (item.type === "text") {
      const action = useAppStore.getState().config.double_click_action || "preview";
      if (action === "preview") {
        openEditor(item);
      } else {
        setPastingId(item.id);
        try {
          await navigator.clipboard.writeText(item.text);
          toast("已复制到剪贴板", "success");
        } catch {
          toast("复制失败", "error");
        } finally {
          setPastingId(null);
        }
      }
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
  const handleBatchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    await deleteHistory(ids);
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
    } catch {
      toast("导出失败", "error");
    }
  }, [selectedIds, items, toast]);

  const handleBatchCopy = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const textItems = items.filter((i) => ids.includes(i.id) && i.type === "text");
    if (textItems.length === 0) {
      toast("选中的记录中没有文本内容", "info");
      return;
    }
    const merged = textItems.map((i) => i.text).join("\n");
    try {
      await navigator.clipboard.writeText(merged);
      toast(`已合并复制 ${textItems.length} 条文本`, "success");
    } catch {
      toast("复制失败", "error");
    }
  }, [selectedIds, items, toast]);

  const selectedCount = items.filter((i) => selectedIds.has(i.id)).length;

  // ── 时间轴设置 ──
  const timelineEnabled = useAppStore((s) => s.config.timeline_enabled);
  const sequentialHotkey = useAppStore((s) => s.config.sequential_hotkey);

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

      <div
        className={`${styles.scrollArea} ${timelineExpanded ? styles.scrollAreaTimelineVisible : ""}`}
        ref={handleScrollRef}
        role="listbox"
        aria-label="剪贴板记录列表"
        aria-multiselectable="true"
        aria-setsize={items.length}
      >
        <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>
          {items.length === 0 ? "没有符合条件的记录" : `共 ${items.length} 条记录`}
        </div>
        <div ref={contentRef} className={styles.cardList}>
        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              {searchKeyword ? (
                <Search size={28} style={{ color: "var(--accent)" }} strokeWidth={1.5} />
              ) : hasActiveFilter ? (
                <FileX size={28} style={{ color: "var(--accent)" }} strokeWidth={1.5} />
              ) : (
                <ClipboardList size={28} style={{ color: "var(--accent)" }} strokeWidth={1.5} />
              )}
            </div>
            <div style={{ textAlign: "center" }}>
              <p className={styles.emptyTitle}>
                {searchKeyword
                  ? `没有找到 "${searchKeyword}" 的相关记录`
                  : hasActiveFilter
                    ? "没有符合条件的记录"
                    : "剪贴板是空的"}
              </p>
              <p className={styles.emptyDesc}>
                {searchKeyword
                  ? "试试调整关键词，或检查拼写是否正确"
                  : hasActiveFilter
                    ? "当前筛选条件下没有匹配的记录，试试放宽部分条件"
                    : "复制任意内容，它会自动出现在这里"}
              </p>
              {hasActiveFilter && (
                <div className={styles.emptyActions}>
                  {searchKeyword && (
                    <button onClick={() => useAppStore.getState().setSearchKeyword("")} className={styles.emptyClearBtn}>
                      清除搜索条件
                    </button>
                  )}
                  <button onClick={clearAllFilters} className={styles.emptyClearBtn}>
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
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Copy size={18} style={{ color: "var(--accent)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>自动记录</div><div className={styles.guideDesc}>Ctrl+C 复制内容自动保存</div></div>
                </div>
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Search size={18} style={{ color: "var(--accent)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>搜索查找</div><div className={styles.guideDesc}>输入关键词快速定位</div></div>
                </div>
                <div className={styles.guideCard}>
                  <div className={styles.guideIcon} style={{ background: "var(--accent-light)" }}><Zap size={18} style={{ color: "var(--accent)" }} /></div>
                  <div className={styles.guideText}><div className={styles.guideLabel}>依次粘贴</div><div className={styles.guideDesc}>{sequentialHotkey || "ctrl+alt+q"} 逐条粘贴</div></div>
                </div>
                <div className={styles.guideFooterHint}>
                  💡 按 <kbd>?</kbd> 查看所有快捷键 · 点击右上角 <span style={{ color: "var(--accent)" }}>❓</span> 打开帮助
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
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
                <button onClick={handleBatchCopy} className={styles.batchBtn} title="合并复制选中文本" aria-label="合并复制选中文本">
                  <Copy size={12} /> 合并复制
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
            <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = items[vItem.index];
                if (!item) return null;
                return (
                  <div key={item.id} data-index={vItem.index} data-item-id={item.id} ref={virtualizer.measureElement}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vItem.start}px)` }}>
                      <VirtualCardRow
                        item={item} selected={focusId === item.id || selectedIds.has(item.id)}
                        imageState={item.type === "image" && item.content ? imgCache[item.content] : undefined}
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
            </div>
            {items.length > 0 && (
              <div className={styles.loadMoreArea}>
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
              </div>
            )}
          </>
        )}
      </div>

      {/* 弹窗 */}
      <ItemEditorDialog />
      <Suspense fallback={null}>
        {qrItem && <ErrorBoundary fallback={null}><QRCodeDialog text={qrItem.text} onClose={() => setQrItem(null)} /></ErrorBoundary>}
      </Suspense>
      <Suspense fallback={null}>
        {diffPair && <ErrorBoundary fallback={null}><DiffDialog oldItem={diffPair[0]} newItem={diffPair[1]} onClose={() => setDiffPair(null)} /></ErrorBoundary>}
      </Suspense>
      <Suspense fallback={null}>
        {regexPreview && <ErrorBoundary fallback={null}><RegexPreviewDialogWrapper item={regexPreview.item} ruleId={regexPreview.ruleId} onClose={() => setRegexPreview(null)} /></ErrorBoundary>}
      </Suspense>
      <Suspense fallback={null}>
        {showRegexRules && <ErrorBoundary fallback={null}><RegexRulesDialog onClose={() => setShowRegexRules(false)} /></ErrorBoundary>}
      </Suspense>
      <TagEditor open={!!tagEditorItem} item={tagEditorItem} onClose={() => setTagEditorItem(null)} />

    </div>
    </div>
    </ContextMenu>
  );
}
