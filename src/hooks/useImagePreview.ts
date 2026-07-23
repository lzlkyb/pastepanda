/**
 * useImagePreview — 图片预览 + OCR 逻辑（从 CardList.tsx 提取）
 *
 * 管理：预览状态（scale/rotation/offset/panning）、OCR 识别与框选、
 * 预览状态缓存（按图片路径记忆缩放/旋转/偏移）。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HistoryItem } from "@/stores/appStore";
import { getImageThumbnail, getImageDataUrl, getImageInfo } from "@/lib/api";
import { useToast } from "@/components/Toast";

// ===== 类型 =====

export interface OcrWordInfo {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OcrLineInfo {
  text: string;
  words: OcrWordInfo[];
}
export interface OcrResultData {
  lines: OcrLineInfo[];
  full_text: string;
}

export interface PreviewInfo {
  width: number;
  height: number;
  file_size: number;
  size_str: string;
  file_name: string;
  path: string;
}

export interface UseImagePreviewReturn {
  // 预览状态
  previewImage: string | null;
  previewInfo: PreviewInfo | null;
  previewLoading: boolean;
  previewScale: number;
  previewRotation: number;
  previewOffset: { x: number; y: number };
  isPanning: boolean;
  previewContentRef: React.MutableRefObject<string | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  // OCR 状态
  ocrResult: OcrResultData | null;
  ocrLoading: boolean;
  ocrActive: boolean;
  selectedWordIndices: Set<string>;
  isSelecting: boolean;
  selRect: { x: number; y: number; w: number; h: number } | null;
  // 操作
  openImagePreview: (item: HistoryItem) => void;
  closePreview: () => void;
  setPreviewScale: React.Dispatch<React.SetStateAction<number>>;
  setPreviewRotation: React.Dispatch<React.SetStateAction<number>>;
  setPreviewOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setSelectedWordIndices: React.Dispatch<React.SetStateAction<Set<string>>>;
  // 事件处理
  handlePreviewWheel: (e: React.WheelEvent) => void;
  handlePanStart: (e: React.MouseEvent) => void;
  handlePanMove: (e: React.MouseEvent) => void;
  handlePanEnd: () => void;
  // OCR 操作
  handleOcrRecognize: () => void;
  toggleOcrOverlay: () => void;
  getSelectedOcrTexts: () => string[];
  handleOcrWordClick: (lineIdx: number, wordIdx: number, e: React.MouseEvent) => void;
  handleOcrSelectStart: (e: React.MouseEvent) => void;
  handleOcrSelectMove: (e: React.MouseEvent) => void;
  handleOcrSelectEnd: () => void;
  handlePinImage: () => void;
}

export function useImagePreview(): UseImagePreviewReturn {
  const { toast } = useToast();

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // OCR 状态
  const [ocrResult, setOcrResult] = useState<OcrResultData | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrActive, setOcrActive] = useState(false);
  const [selectedWordIndices, setSelectedWordIndices] = useState<Set<string>>(new Set());
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

  // 同步预览状态到 ref
  previewStateRef.current = { scale: previewScale, rotation: previewRotation, offset: previewOffset };

  const openImagePreview = useCallback(async (item: HistoryItem) => {
    const requestContent = item.content || null;
    setPreviewImage(null);
    setPreviewInfo(null);
    previewContentRef.current = requestContent;

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
    if (previewContentRef.current !== requestContent) return;
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
    if (previewContentRef.current !== requestContent) return;
    setPreviewLoading(false);

    if (dataUrl) {
      setPreviewImage(dataUrl);
      setPreviewInfo(info);
    } else if (!thumbUrl) {
      toast("加载图片失败", "error");
    }
  }, [toast]);

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
      // 上限 50 条，淘汰最旧
      const keys = Object.keys(previewStateCache.current);
      if (keys.length > 50) {
        for (const k of keys.slice(0, keys.length - 50)) {
          delete previewStateCache.current[k];
        }
      }
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

  // ESC 键关闭预览 / 清除 OCR 选择
  useEffect(() => {
    if (!previewImage && !previewLoading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (ocrActive && selectedWordIndices.size > 0) {
          setSelectedWordIndices(new Set());
        } else if (ocrActive) {
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
      setPreviewScale((prev) => {
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        return Math.max(0.2, Math.min(5, prev + delta));
      });
    } else {
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
    const vp = viewportRef.current;
    const maxOffset = vp ? Math.max(vp.clientWidth, vp.clientHeight) * 2 : 2000;
    const clamp = (v: number) => Math.max(-maxOffset, Math.min(maxOffset, v));
    setPreviewOffset({
      x: clamp(panStartRef.current.offsetX + (e.clientX - panStartRef.current.x)),
      y: clamp(panStartRef.current.offsetY + (e.clientY - panStartRef.current.y)),
    });
  }, [isPanning]);

  const handlePanEnd = useCallback(() => {
    setIsPanning(false);
  }, []);

  // ========== OCR 相关 ==========

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

  const toggleOcrOverlay = useCallback(() => {
    if (ocrActive) {
      setOcrActive(false);
      setSelectedWordIndices(new Set());
    } else {
      if (!ocrResult) {
        handleOcrRecognize();
      } else {
        setOcrActive(true);
      }
    }
  }, [ocrActive, ocrResult, handleOcrRecognize]);

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

  const handleOcrSelectStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
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

  const handleOcrSelectEnd = useCallback(() => {
    if (!isSelecting || !selRect || !ocrResult) {
      setIsSelecting(false);
      setSelRect(null);
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) { setIsSelecting(false); setSelRect(null); return; }
    const vr = viewport.getBoundingClientRect();

    setSelectedWordIndices(prev => {
      const next = new Set(prev);
      ocrResult.lines.forEach((line, li) => {
        line.words.forEach((word, wi) => {
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

  return {
    previewImage, previewInfo, previewLoading,
    previewScale, previewRotation, previewOffset, isPanning,
    previewContentRef, viewportRef,
    ocrResult, ocrLoading, ocrActive, selectedWordIndices, isSelecting, selRect,
    openImagePreview, closePreview,
    setPreviewScale, setPreviewRotation, setPreviewOffset, setSelectedWordIndices,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    handleOcrRecognize, toggleOcrOverlay, getSelectedOcrTexts,
    handleOcrWordClick, handleOcrSelectStart, handleOcrSelectMove, handleOcrSelectEnd,
    handlePinImage,
  };
}
