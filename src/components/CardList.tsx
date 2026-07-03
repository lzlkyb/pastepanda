import { useState, useEffect, useRef, lazy, Suspense, useCallback } from "react";
import { motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { CardWithContext, ImgState } from "@/components/Card";
import { ContextMenu } from "@/components/ContextMenu";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { pasteText, pasteImage, getImageThumbnail, getImageDataUrl, getImageBase64, getImageInfo, loadMoreHistory, deleteHistory } from "@/lib/api";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardList, Copy, Search, Zap, ZoomIn, ZoomOut, RotateCw, Download, X, Info, Trash2, FileDown, ScanText, Pin, CheckSquare, Square } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import styles from "./CardList.module.css";

const EditDialog = lazy(() => import("@/components/EditDialog").then(m => ({ default: m.EditDialog })));
const FileDetailDialog = lazy(() => import("@/components/FileDetailDialog").then(m => ({ default: m.FileDetailDialog })));

// OCR 词信息类型
interface OcrWordInfo {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface OcrLineInfo {
  text: string;
  words: OcrWordInfo[];
}
interface OcrResultData {
  lines: OcrLineInfo[];
  full_text: string;
}

export function CardList() {
  const history = useAppStore((s) => s.history);
  const searchKeyword = useAppStore((s) => s.searchKeyword);
  const filterType = useAppStore((s) => s.filterType);
  const getFilteredItems = useAppStore((s) => s.getFilteredItems);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const focusId = useAppStore((s) => s.focusId);
  const selectItem = useAppStore((s) => s.selectItem);

  const { toast } = useToast();
  const [editItem, setEditItem] = useState<HistoryItem | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<Record<string, string | number> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // OCR 状态
  const [ocrResult, setOcrResult] = useState<OcrResultData | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrActive, setOcrActive] = useState(false); // OCR 叠加层是否显示
  const [selectedWordIndices, setSelectedWordIndices] = useState<Set<string>>(new Set()); // "lineIdx-wordIdx"
  const [isSelecting, setIsSelecting] = useState(false);
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  // 使用 ref 存储预览状态，避免 closePreview 闭包导致 ESC 监听器频繁重新注册
  const previewStateRef = useRef({ scale: 1, rotation: 0, offset: { x: 0, y: 0 } });
  // 保存每个图片的上次预览状态（按 content 路径 key）
  const previewStateCache = useRef<Record<string, { scale: number; rotation: number; offset: { x: number; y: number } }>>({});
  // 当前预览的图片 content 路径（用于关闭时保存状态）
  const previewContentRef = useRef<string | null>(null);
  const [fileDetailItem, setFileDetailItem] = useState<HistoryItem | null>(null);
  const [pastingId, setPastingId] = useState<string | null>(null); // 正在粘贴中的卡片 ID
  const [imgCache, setImgCache] = useState<Record<string, ImgState>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false); // 列表是否在滚动中（用于禁用 Popover）
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const loadedPathsRef = useRef<Set<string>>(new Set());

  // 滚动到底部时加载更多
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    // 标记滚动中：触发 hover 卡片时不再显示 Popover，避免滚动时频繁渲染
    setIsScrolling(true);
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null;
      setIsScrolling(false);
    }, 120);
    if (!hasMore || loadingMore) return;
    const el = scrollRef.current;
    const threshold = 80; // 距底部 80px 时触发
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
      setLoadingMore(true);
      setLoadError(false);
      loadMoreHistory().then((more) => {
        setHasMore(more);
        setLoadingMore(false);
        setRetryCount(0);
      }).catch(() => {
        setLoadingMore(false);
        setLoadError(true);
      });
    }
  }, [hasMore, loadingMore]);

  // 手动重试加载
  const handleRetryLoadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setLoadError(false);
    loadMoreHistory().then((more) => {
      setHasMore(more);
      setLoadingMore(false);
      setRetryCount(0);
    }).catch(() => {
      setLoadingMore(false);
      setLoadError(true);
      setRetryCount((c) => c + 1);
    });
  }, [loadingMore]);

  // 统一使用 store 的过滤排序逻辑（包含拼音搜索、置顶排序等）
  const items = getFilteredItems();

  // 虚拟列表
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 82,
    overscan: 8,
  });

  // 异步加载图片缩略图（使用小尺寸缩略图 + 并行加载）
  useEffect(() => {
    const imageItems = items.filter(
      (i) => i.type === "image" && i.content && !loadedPathsRef.current.has(i.content)
    );
    if (imageItems.length === 0) return;

    let cancelled = false;
    const pathsToLoad = imageItems.map((i) => i.content!);
    pathsToLoad.forEach((p) => loadedPathsRef.current.add(p));

    const loadingStates: Record<string, ImgState> = {};
    for (const path of pathsToLoad) loadingStates[path] = { status: "loading" };
    setImgCache((prev) => ({ ...prev, ...loadingStates }));

    // 并行加载所有缩略图（最多6个并发）
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
          updates[path] = result.status === "fulfilled" && result.value
            ? { status: "loaded", url: result.value }
            : { status: "error" };
        });
        setImgCache((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

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
    loadedPathsRef.current.add(content);
    setImgCache((prev) => ({ ...prev, [content]: { status: "loading" } }));
    getImageThumbnail(content).then((dataUrl) => {
      setImgCache((prev) => ({ ...prev, [content]: dataUrl ? { status: "loaded", url: dataUrl } : { status: "error" } }));
    }).catch(() => setImgCache((prev) => ({ ...prev, [content]: { status: "error" } })));
  }, []);

  const openImagePreview = useCallback(async (item: HistoryItem) => {
    setPreviewImage(null);
    setPreviewInfo(null);
    previewContentRef.current = item.content || null;

    // 重置 OCR 状态
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());

    // 恢复上次的预览状态（如果有）
    const cached = item.content ? previewStateCache.current[item.content] : null;
    if (cached) {
      setPreviewScale(cached.scale);
      setPreviewRotation(cached.rotation);
      setPreviewOffset(cached.offset);
    } else {
      setPreviewScale(1);
      setPreviewRotation(0);
      setPreviewOffset({ x: 0, y: 0 });
    }

    // 先尝试用已有缩略图占位（秒开）
    const thumbUrl = await getImageThumbnail(item.content).catch(() => "");
    if (thumbUrl) {
      setPreviewImage(thumbUrl);
      setPreviewLoading(false);
    } else {
      setPreviewLoading(true);
    }

    // 后台加载原图
    const [dataUrl, info] = await Promise.all([
      getImageDataUrl(item.content),
      getImageInfo(item.content),
    ]);
    setPreviewLoading(false);

    if (dataUrl) {
      setPreviewImage(dataUrl);
      setPreviewInfo(info);
    } else if (!thumbUrl) {
      toast("加载图片失败", "error");
    }
  }, [toast]);

  const handleDoubleClick = useCallback(async (item: HistoryItem) => {
    if (item.type === "image" && item.content) {
      const action = useAppStore.getState().config.double_click_action || "preview";
      if (action === "copy") {
        // 复制图片到剪贴板 — 通过 Rust 后端获取 base64
        setPastingId(item.id);
        try {
          const dataUrl = await getImageBase64(item.content);
          const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
          const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
          const base64Data = dataUrl.split(",")[1];
          const byteChars = atob(base64Data);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          const blob = new Blob([bytes], { type: mimeType });
          await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
          toast("图片已复制", "success");
        } catch {
          toast("复制图片失败", "error");
        } finally {
          setPastingId(null);
        }
      } else {
        openImagePreview(item);
      }
    } else if (item.type === "file") {
      setFileDetailItem(item);
    } else if (item.type === "text") {
      const action = useAppStore.getState().config.double_click_action || "preview";
      if (action === "preview") {
        // 预览 = 进入编辑模式
        setEditItem(item);
      } else {
        // 默认：复制到剪贴板
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
  }, [openImagePreview, toast]);

  // 同步预览状态到 ref
  previewStateRef.current = { scale: previewScale, rotation: previewRotation, offset: previewOffset };

  const closePreview = useCallback(() => {
    // 保存当前预览状态（按图片路径）
    const contentKey = previewContentRef.current;
    if (contentKey) {
      const state = previewStateRef.current;
      previewStateCache.current[contentKey] = {
        scale: state.scale,
        rotation: state.rotation,
        offset: state.offset,
      };
    }
    previewContentRef.current = null;
    setPreviewImage(null);
    setPreviewInfo(null);
    setPreviewScale(1);
    setPreviewRotation(0);
    setPreviewOffset({ x: 0, y: 0 });
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());
  }, []);

  // 卸载时清理滚动 timer
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  // ESC 键关闭预览 / 清除 OCR 选择
  useEffect(() => {
    if (!previewImage && !previewLoading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (ocrActive && selectedWordIndices.size > 0) {
          // 有 OCR 选中时先清除选择
          setSelectedWordIndices(new Set());
        } else if (ocrActive) {
          // OCR 激活但无选择时关闭 OCR
          setOcrActive(false);
        } else {
          closePreview();
        }
      }
      // Ctrl+C 复制选中 OCR 文字
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedWordIndices.size > 0) {
        e.preventDefault();
        const texts = getSelectedOcrTexts();
        navigator.clipboard.writeText(texts.join(' ')).then(() => {
          toast("已复制选中文字", "success");
        }).catch(() => {
          toast("复制失败", "error");
        });
      }
      // 快捷键：0 重置 / R 旋转 / +/- 缩放
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case '0': setPreviewScale(1); setPreviewOffset({ x: 0, y: 0 }); break;
        case 'r': case 'R': setPreviewRotation(r => (r + 90) % 360); break;
        case '+': case '=': setPreviewScale(s => Math.min(5, s + 0.25)); break;
        case '-': setPreviewScale(s => Math.max(0.2, s - 0.25)); break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewImage, previewLoading, closePreview, ocrActive, selectedWordIndices, toast]);

  const handlePreviewWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // Ctrl+滚轮 = 缩放
      setPreviewScale((prev) => {
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        return Math.max(0.2, Math.min(5, prev + delta));
      });
    } else {
      // 普通滚轮 = 垂直/水平平移
      setPreviewOffset((prev) => ({
        x: prev.x - (e.shiftKey ? e.deltaY : e.deltaX),
        y: prev.y - (e.shiftKey ? e.deltaX : e.deltaY),
      }));
    }
  }, []);

  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsPanning(true);
    panStartRef.current = { x: e.clientX, y: e.clientY, offsetX: previewOffset.x, offsetY: previewOffset.y };
  }, [previewOffset]);

  const handlePanMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setPreviewOffset({
      x: panStartRef.current.offsetX + (e.clientX - panStartRef.current.x),
      y: panStartRef.current.offsetY + (e.clientY - panStartRef.current.y),
    });
  }, [isPanning]);

  const handlePanEnd = useCallback(() => {
    setIsPanning(false);
  }, []);

  // ========== OCR 相关函数 ==========

  // 执行 OCR 识别
  const handleOcrRecognize = useCallback(async () => {
    const path = previewContentRef.current;
    if (!path) return;
    setOcrLoading(true);
    try {
      const result = await invoke<OcrResultData>("ocr_image", { path });
      setOcrResult(result);
      setOcrActive(true);
      setSelectedWordIndices(new Set());
    } catch (e) {
      toast("OCR 识别失败: " + (e instanceof Error ? e.message : String(e)), "error");
    } finally {
      setOcrLoading(false);
    }
  }, [toast]);

  // 切换 OCR 叠加层
  const toggleOcrOverlay = useCallback(() => {
    if (ocrActive) {
      setOcrActive(false);
      setSelectedWordIndices(new Set());
    } else {
      // 如果还没识别过，自动触发
      if (!ocrResult) {
        handleOcrRecognize();
      } else {
        setOcrActive(true);
      }
    }
  }, [ocrActive, ocrResult, handleOcrRecognize]);

  // 获取选中词的文本列表
  const getSelectedOcrTexts = useCallback((): string[] => {
    if (!ocrResult) return [];
    const texts: string[] = [];
    selectedWordIndices.forEach(key => {
      const [li, wi] = key.split('-').map(Number);
      const word = ocrResult.lines[li]?.words[wi];
      if (word) texts.push(word.text);
    });
    return texts;
  }, [ocrResult, selectedWordIndices]);

  // 点击 OCR 词
  const handleOcrWordClick = useCallback((lineIdx: number, wordIdx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = `${lineIdx}-${wordIdx}`;
    setSelectedWordIndices(prev => {
      const next = new Set(prev);
      if (e.ctrlKey || e.metaKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else {
        if (next.has(key) && next.size === 1) {
          next.clear();
        } else {
          next.clear();
          next.add(key);
        }
      }
      return next;
    });
  }, []);

  // OCR 框选开始
  const handleOcrSelectStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 如果点击的是词框，不触发框选
    if ((e.target as HTMLElement).closest('[data-ocr-word-box]')) return;
    const viewport = e.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    setIsSelecting(true);
    selStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setSelRect({ x: selStartRef.current.x, y: selStartRef.current.y, w: 0, h: 0 });
    if (!e.ctrlKey && !e.metaKey) {
      setSelectedWordIndices(new Set());
    }
  }, []);

  // OCR 框选移动
  const handleOcrSelectMove = useCallback((e: React.MouseEvent) => {
    if (!isSelecting) return;
    const viewport = e.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const x = Math.min(selStartRef.current.x, cx);
    const y = Math.min(selStartRef.current.y, cy);
    const w = Math.abs(cx - selStartRef.current.x);
    const h = Math.abs(cy - selStartRef.current.y);
    setSelRect({ x, y, w, h });
  }, [isSelecting]);

  // OCR 框选结束
  const handleOcrSelectEnd = useCallback(() => {
    if (!isSelecting || !selRect || !ocrResult) {
      setIsSelecting(false);
      setSelRect(null);
      return;
    }
    // 检测哪些词在框选区域内
    const viewport = viewportRef.current;
    if (!viewport) { setIsSelecting(false); setSelRect(null); return; }
    const vr = viewport.getBoundingClientRect();

    setSelectedWordIndices(prev => {
      const next = new Set(prev);
      ocrResult.lines.forEach((line, li) => {
        line.words.forEach((word, wi) => {
          // OCR 坐标是相对于原图的，需要映射到视口
          const imgEl = viewport.querySelector('img') as HTMLImageElement;
          if (!imgEl) return;
          const imgRect = imgEl.getBoundingClientRect();
          const imgNaturalW = imgEl.naturalWidth || 1;
          const imgNaturalH = imgEl.naturalHeight || 1;
          const scaleX = imgRect.width / imgNaturalW;
          const scaleY = imgRect.height / imgNaturalH;

          const wx = imgRect.left - vr.left + word.x * scaleX;
          const wy = imgRect.top - vr.top + word.y * scaleY;
          const ww = word.width * scaleX;
          const wh = word.height * scaleY;

          const overlap = !(wx + ww < selRect!.x || wx > selRect!.x + selRect!.w ||
                             wy + wh < selRect!.y || wy > selRect!.y + selRect!.h);
          const key = `${li}-${wi}`;
          if (overlap) {
            next.add(key);
          }
        });
      });
      return next;
    });

    setIsSelecting(false);
    setSelRect(null);
  }, [isSelecting, selRect, ocrResult]);

  // 置顶图片
  const handlePinImage = useCallback(async () => {
    const path = previewContentRef.current;
    if (!path) return;
    try {
      await invoke("open_pinned_image", { path });
      toast("图片已置顶", "success");
    } catch (e) {
      toast("置顶失败: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [toast]);

  // 批量删除
  const handleBatchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await deleteHistory(ids);
      toast(`已删除 ${ids.length} 条记录`, "success");
    } catch {
      toast("批量删除失败", "error");
    }
    setShowBatchDeleteConfirm(false);
  }, [selectedIds, toast]);

  // 批量导出
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

  // 批量复制（合并所有选中文本）
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

  // 只计数当前可见列表中的有效选中项
  const selectedCount = items.filter((i) => selectedIds.has(i.id)).length;

  return (
    <ContextMenu>
    <div className={styles.scrollArea} ref={scrollRef} onScroll={handleScroll} role="listbox" aria-label="剪贴板记录列表" aria-multiselectable="true" aria-setsize={items.length} aria-live="polite">
      <div className={styles.cardList}>
        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <ClipboardList size={28} style={{ color: "var(--accent)" }} strokeWidth={1.5} />
            </div>
            <div style={{ textAlign: "center" }}>
              <p className={styles.emptyTitle}>
                {searchKeyword ? "没有找到匹配的记录" : filterType !== "all" ? "该分类暂无记录" : "剪贴板是空的"}
              </p>
              <p className={styles.emptyDesc}>
                {searchKeyword ? "试试其他关键词" : "复制任意内容，它会自动出现在这里"}
              </p>
              {searchKeyword && (
                <button onClick={() => useAppStore.getState().setSearchKeyword("")} className={styles.emptyClearBtn}>
                  清除搜索条件
                </button>
              )}
            </div>
            {!searchKeyword && filterType === "all" && (
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
                  <div className={styles.guideText}><div className={styles.guideLabel}>依次粘贴</div><div className={styles.guideDesc}>Ctrl+Q 逐条粘贴</div></div>
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
                <button onClick={() => setShowBatchDeleteConfirm(true)} className={`${styles.batchBtn} ${styles.batchBtnDanger}`} title="删除选中记录" aria-label="删除选中记录">
                  <Trash2 size={12} /> 删除
                </button>
              </div>
            )}
            <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = items[vItem.index];
                return (
                  <div key={item.id} data-index={vItem.index} data-item-id={item.id} ref={virtualizer.measureElement}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vItem.start}px)` }}>
                        <CardWithContext
                          key={item.id} item={item} selected={focusId === item.id || selectedIds.has(item.id)}
                          imageState={item.type === "image" && item.content ? imgCache[item.content] : undefined}
                          searchKeyword={searchKeyword}
                          pasting={pastingId === item.id}
                          onRetryImage={item.type === "image" && item.content && imgCache[item.content]?.status === "error"
                            ? () => handleRetryImage(item.content) : undefined}
                          onClick={(e: React.MouseEvent) => selectItem(item.id, e.ctrlKey, e.shiftKey)}
                          onDoubleClick={() => handleDoubleClick(item)}
                          onEdit={(item) => setEditItem(item)}
                          index={vItem.index}
                          disablePreview={isScrolling || selectedCount > 0}
                        />
                  </div>
                );
              })}
            </div>
            {hasMore && items.length > 0 && (
              <div className={styles.loadMoreArea}>
                {loadingMore && <span className={styles.loadMoreHint}>加载中…</span>}
                {loadError && !loadingMore && (
                  <>
                    <span className={styles.loadMoreError}>加载失败{retryCount > 0 ? ` (已重试 ${retryCount} 次)` : ""}</span>
                    <button onClick={handleRetryLoadMore} className={styles.loadMoreRetryBtn}>重试</button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 弹窗 */}
      <Suspense fallback={null}>
        {editItem && <ErrorBoundary fallback={null}><EditDialog item={editItem} onClose={() => setEditItem(null)} /></ErrorBoundary>}
      </Suspense>
      <Suspense fallback={null}>
        {fileDetailItem && <ErrorBoundary fallback={null}><FileDetailDialog item={fileDetailItem} onClose={() => setFileDetailItem(null)} /></ErrorBoundary>}
      </Suspense>

      {/* 图片预览 — 统一 dialog 风格 */}
      {(previewImage || previewLoading) && (
        <div className="dialog-backdrop" style={{ zIndex: 60 }} onClick={closePreview}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 20 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`dialog-box ${styles.imageDetailDialog}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="dialog-header">
              <h2 className="dialog-title">🖼 图片详情</h2>
              <button onClick={closePreview} className="dialog-close"><X size={16} /></button>
            </div>

            {/* Body */}
            <div className="dialog-body" style={{ gap: 12 }}>
              {/* 元信息标签行 */}
              {previewInfo && (
                <div className={styles.imageDetailMeta}>
                  <span className={`${styles.imageDetailTag} ${styles.imageDetailTagAccent}`}>📄 {previewInfo.file_name}</span>
                  <span className={styles.imageDetailTag}>{previewInfo.width} × {previewInfo.height}</span>
                  <span className={styles.imageDetailTag}>{previewInfo.size_str}</span>
                  <span className={styles.imageDetailTag}>来自剪贴板</span>
                </div>
              )}

              {/* 工具栏 */}
              <div className={styles.imageDetailToolbar}>
                <button className={styles.imageDetailToolBtn} title="缩小" onClick={() => setPreviewScale((s) => Math.max(0.2, s - 0.25))}><ZoomOut size={16} /></button>
                <span className={styles.imageDetailZoomLabel}>{Math.round(previewScale * 100)}%</span>
                <button className={styles.imageDetailToolBtn} title="放大" onClick={() => setPreviewScale((s) => Math.min(5, s + 0.25))}><ZoomIn size={16} /></button>
                <button className={styles.imageDetailToolBtn} title="适应窗口" onClick={() => { setPreviewScale(1); setPreviewOffset({ x: 0, y: 0 }); }}>1:1</button>
                <button className={styles.imageDetailToolBtn} title="旋转" onClick={() => setPreviewRotation((r) => (r + 90) % 360)}><RotateCw size={16} /></button>
                <span className={styles.imageDetailToolbarSep} />
                {/* OCR 识别按钮 */}
                <button
                  className={`${styles.imageDetailToolBtn} ${styles.ocrToolBtn}${ocrActive ? ' ' + styles.ocrToolBtnActive : ''}`}
                  title={ocrActive ? "关闭文字识别" : "识别图片中的文字"}
                  onClick={toggleOcrOverlay}
                  disabled={ocrLoading}
                >
                  {ocrLoading ? <div className={styles.ocrSpinnerSmall} /> : <ScanText size={16} />}
                  <span style={{ marginLeft: 4, fontSize: 12 }}>{ocrActive ? '文字已识别' : '识别文字'}</span>
                </button>
                {/* 置顶按钮 */}
                <button
                  className={`${styles.imageDetailToolBtn} ${styles.pinToolBtn}`}
                  title="将图片钉在屏幕最上层"
                  onClick={handlePinImage}
                >
                  <Pin size={16} />
                  <span style={{ marginLeft: 4, fontSize: 12 }}>置顶</span>
                </button>
              </div>

              {/* 图片查看区 */}
              <div
                ref={viewportRef}
                className={styles.imageDetailViewport}
                onWheel={handlePreviewWheel}
                onMouseDown={ocrActive ? handleOcrSelectStart : handlePanStart}
                onMouseMove={ocrActive ? handleOcrSelectMove : handlePanMove}
                onMouseUp={ocrActive ? handleOcrSelectEnd : handlePanEnd}
                onMouseLeave={ocrActive ? handleOcrSelectEnd : handlePanEnd}
                style={{
                  cursor: ocrActive ? (isSelecting ? 'crosshair' : 'text') : isPanning ? "grabbing" : previewScale > 1 ? "grab" : "default",
                  position: 'relative',
                }}
              >
                {/* OCR 加载遮罩 */}
                {ocrLoading && (
                  <div className={styles.imageDetailLoading}>
                    <div className={styles.imageDetailSpinner} />
                    <span>正在识别文字…</span>
                  </div>
                )}
                {previewLoading && !ocrLoading ? (
                  <div className={styles.imageDetailLoading}>
                    <div className={styles.imageDetailSpinner} />
                    <span>加载中…</span>
                  </div>
                ) : previewImage ? (
                  <>
                    <img
                      src={previewImage}
                      alt="预览"
                      className={styles.imageDetailImg}
                      style={{
                        transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale}) rotate(${previewRotation}deg)`,
                        transition: isPanning ? "none" : "transform 0.2s ease",
                      }}
                      draggable={false}
                    />
                    {/* OCR 文字叠加层 */}
                    {ocrActive && ocrResult && (
                      <div className={styles.ocrOverlayContainer} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {ocrResult.lines.map((line, li) =>
                          line.words.map((word, wi) => {
                            const key = `${li}-${wi}`;
                            const selected = selectedWordIndices.has(key);
                            // OCR 坐标映射：需要根据图片的实际显示位置计算
                            // 简化处理：用百分比定位
                            const viewport = viewportRef.current;
                            const imgEl = viewport?.querySelector('img') as HTMLImageElement | null;
                            let left = 0, top = 0, width = 0, height = 0;
                            if (imgEl && imgEl.naturalWidth && imgEl.naturalHeight) {
                              const imgRect = imgEl.getBoundingClientRect();
                              const viewportEl = viewport;
                              const vpRect = viewportEl?.getBoundingClientRect();
                              if (vpRect) {
                                const scaleX = imgRect.width / imgEl.naturalWidth;
                                const scaleY = imgRect.height / imgEl.naturalHeight;
                                left = (imgRect.left - vpRect.left) / vpRect.width * 100 + (word.x * scaleX / vpRect.width * 100);
                                top = (imgRect.top - vpRect.top) / vpRect.height * 100 + (word.y * scaleY / vpRect.height * 100);
                                width = word.width * scaleX / vpRect.width * 100;
                                height = word.height * scaleY / vpRect.height * 100;
                              }
                            }
                            return (
                              <div
                                key={key}
                                data-ocr-word-box
                                className={`${styles.ocrWordBox}${selected ? ' ' + styles.ocrWordSelected : ''}`}
                                style={{
                                  position: 'absolute',
                                  left: `${left}%`,
                                  top: `${top}%`,
                                  width: `${width}%`,
                                  height: `${height}%`,
                                  border: selected ? '1.5px solid rgba(16,185,129,0.8)' : '1px solid rgba(99,102,241,0.35)',
                                  background: selected ? 'rgba(16,185,129,0.18)' : 'rgba(99,102,241,0.06)',
                                  borderRadius: 2,
                                  pointerEvents: 'auto',
                                  cursor: 'pointer',
                                  zIndex: selected ? 2 : 1,
                                }}
                                onClick={(e) => handleOcrWordClick(li, wi, e)}
                                title={word.text}
                              />
                            );
                          })
                        )}
                        {/* 框选矩形 */}
                        {isSelecting && selRect && (
                          <div style={{
                            position: 'absolute',
                            left: selRect.x,
                            top: selRect.y,
                            width: selRect.w,
                            height: selRect.h,
                            border: '1px dashed #6366f1',
                            background: 'rgba(99,102,241,0.1)',
                            pointerEvents: 'none',
                            zIndex: 10,
                          }} />
                        )}
                      </div>
                    )}
                  </>
                ) : null}
              </div>

              {/* OCR 选中结果栏 */}
              {ocrActive && ocrResult && (
                <div className={styles.ocrResultBar}>
                  <span style={{ fontSize: 14 }}>🔍</span>
                  <span className={styles.ocrResultCount}>
                    已选 <strong>{selectedWordIndices.size}</strong> 个词
                  </span>
                  <span className={styles.ocrResultPreview}>
                    {selectedWordIndices.size > 0
                      ? getSelectedOcrTexts().join(' ')
                      : '点击图片上的文字区域选择，或拖拽框选'}
                  </span>
                  {selectedWordIndices.size > 0 && (
                    <button
                      className={styles.ocrResultClearBtn}
                      onClick={() => setSelectedWordIndices(new Set())}
                    >
                      清除
                    </button>
                  )}
                  <button
                    className={styles.ocrResultCopyBtn}
                    disabled={selectedWordIndices.size === 0}
                    onClick={() => {
                      const texts = getSelectedOcrTexts();
                      if (texts.length === 0) return;
                      navigator.clipboard.writeText(texts.join(' ')).then(() => {
                        toast("已复制选中文字", "success");
                      }).catch(() => toast("复制失败", "error"));
                    }}
                  >
                    📋 复制选中
                  </button>
                </div>
              )}

              {/* OCR 纯文本结果面板（关闭叠加层时显示） */}
              {!ocrActive && ocrResult && (
                <div className={styles.ocrFullTextPanel}>
                  <div className={styles.ocrFullTextHeader}>
                    <span>🔍 全部识别文字</span>
                    <button
                      className={styles.ocrFullTextCopyBtn}
                      onClick={() => {
                        navigator.clipboard.writeText(ocrResult.full_text).then(() => {
                          toast("已复制全部文字", "success");
                        }).catch(() => toast("复制失败", "error"));
                      }}
                    >
                      📋 全部复制
                    </button>
                  </div>
                  <div className={styles.ocrFullTextBody}>
                    {ocrResult.full_text}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="dialog-footer">
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => {
                  try {
                    const dataUrl = await getImageBase64(previewContentRef.current!);
                    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
                    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
                    const base64Data = dataUrl.split(",")[1];
                    const byteChars = atob(base64Data);
                    const bytes = new Uint8Array(byteChars.length);
                    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
                    const blob = new Blob([bytes], { type: mimeType });
                    await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
                    toast("已复制", "success");
                  } catch { toast("复制失败", "error"); }
                }}><Copy size={14} /> 复制</button>
                <button className="btn-secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={async () => {
                  try {
                    const { save } = await import("@tauri-apps/plugin-dialog");
                    const { invoke } = await import("@tauri-apps/api/core");
                    const defaultName = String(previewInfo?.file_name || "image.png");
                    const path = await save({ defaultPath: defaultName, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
                    if (path && previewContentRef.current) {
                      await invoke("save_image_file", { source: previewContentRef.current, dest: path });
                      toast("已保存", "success");
                    }
                  } catch { toast("保存失败", "error"); }
                }}><Download size={14} /> 另存</button>
              </div>
              <span className={styles.imageDetailHint} style={{ marginLeft: 16 }}>
                {ocrActive ? '点击选词 · 拖拽框选 · Ctrl+C复制' : '滚轮平移 · Ctrl+滚轮缩放 · +/- 缩放 · 0 重置 · R 旋转'}
              </span>
            </div>
          </motion.div>
        </div>
      )}

      {/* 批量删除确认弹窗 */}
      <ConfirmDialog
        open={showBatchDeleteConfirm}
        title="确认批量删除"
        message={`确定删除 ${selectedCount} 条记录？可通过 Ctrl+Z 撤销。`}
        confirmText={`删除 ${selectedCount} 条`}
        variant="danger"
        onConfirm={handleBatchDelete}
        onCancel={() => setShowBatchDeleteConfirm(false)}
      />
    </div>
    </ContextMenu>
  );
}
