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
import {
  type ExportFormat,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_QUALITY,
  withExportExt,
  formatBytes,
} from "@/lib/imageFormat";

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

/** 裁剪选区（视口像素坐标，相对 viewport 左上角） */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UseImagePreviewReturn {
  // 预览状态
  previewImage: string | null;
  previewInfo: PreviewInfo | null;
  /** 当前预览的条目（供“拿选中文字去变换”使用） */
  previewItem: HistoryItem | null;
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
  // 导出（格式转换 + 压缩）状态
  exportFormat: ExportFormat;
  exportQuality: number;
  exportEstimate: number | null;
  exporting: boolean;
  // 操作
  openImagePreview: (item: HistoryItem) => void;
  closePreview: () => void;
  setExportFormat: React.Dispatch<React.SetStateAction<ExportFormat>>;
  setExportQuality: React.Dispatch<React.SetStateAction<number>>;
  exportImage: () => Promise<void>;
  // 裁剪状态
  cropMode: boolean;
  cropRect: CropRect | null;
  cropOriginal: string | null;
  setCropMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCropRect: React.Dispatch<React.SetStateAction<CropRect | null>>;
  handleCropMouseDown: (e: React.MouseEvent) => void;
  handleCropMouseMove: (e: React.MouseEvent) => void;
  handleCropMouseUp: () => void;
  confirmCrop: () => Promise<void>;
  cancelCrop: () => void;
  restoreOriginal: () => void;
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

// 模块级缓存：保存每个图片的上次预览状态（按 content 路径 key）。
// P3 起 hook 实例随 ImageEditor 挂载/卸载，缓存提升到模块级避免关闭即丢失；上限 50 条淘汰最旧。
const previewStateCache: Record<string, { scale: number; rotation: number; offset: { x: number; y: number } }> = {};

export function useImagePreview(): UseImagePreviewReturn {
  const { toast } = useToast();

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  // 当前预览的条目。留着是为了“框选一块 → 拿这段文字去变换”能把它交给枢纽
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);
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
  // 导出（格式转换 + 压缩）状态
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [exportQuality, setExportQuality] = useState<number>(DEFAULT_EXPORT_QUALITY);
  const [exportEstimate, setExportEstimate] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  // 裁剪状态
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropOriginal, setCropOriginal] = useState<string | null>(null);
  const cropDragRef = useRef<{ mode: "draw" | "move" | "resize"; handle: string; sx: number; sy: number; start: CropRect } | null>(null);
  const selStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  // 使用 ref 存储预览状态，避免 closePreview 闭包导致 ESC 监听器频繁重新注册
  const previewStateRef = useRef({ scale: 1, rotation: 0, offset: { x: 0, y: 0 } });
  // 当前预览的图片 content 路径（用于关闭时保存状态）
  const previewContentRef = useRef<string | null>(null);

  // 同步预览状态到 ref
  previewStateRef.current = { scale: previewScale, rotation: previewRotation, offset: previewOffset };

  const openImagePreview = useCallback(async (item: HistoryItem) => {
    const requestContent = item.content || null;
    setPreviewImage(null);
    setPreviewInfo(null);
    setPreviewItem(item);
    previewContentRef.current = requestContent;

    // 重置 OCR 状态
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());
    setExportEstimate(null);
    setCropMode(false);
    setCropRect(null);
    setCropOriginal(null);

    // 恢复上次的预览状态（如果有）
    const cached = item.content ? previewStateCache[item.content] : null;
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
      previewStateCache[contentKey] = {
        scale: state.scale,
        rotation: state.rotation,
        offset: state.offset,
      };
      // 上限 50 条，淘汰最旧
      const keys = Object.keys(previewStateCache);
      if (keys.length > 50) {
        for (const k of keys.slice(0, keys.length - 50)) {
          delete previewStateCache[k];
        }
      }
    }
    previewContentRef.current = null;
    setPreviewImage(null);
    setPreviewInfo(null);
    setPreviewItem(null);
    setPreviewScale(1);
    setPreviewRotation(0);
    setPreviewOffset({ x: 0, y: 0 });
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());
    setCropMode(false);
    setCropRect(null);
    setCropOriginal(null);
  }, []);

  // ESC 键关闭预览 / 清除 OCR 选择
  useEffect(() => {
    if (!previewImage && !previewLoading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (cropMode) {
          setCropMode(false);
          setCropRect(null);
        } else if (ocrActive && selectedWordIndices.size > 0) {
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
    // 不能补 getSelectedOcrTexts：它定义在本 effect 之后，写进依赖数组会 TDZ ReferenceError
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImage, previewLoading, closePreview, ocrActive, selectedWordIndices, cropMode, toast]);

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

  // ========== 导出（格式转换 + 压缩） ==========

  // 将当前预览图按目标格式/质量转码为 Blob（按原图自然尺寸绘制）。
  // jpeg 无透明通道，先铺白底避免透明区域变黑。
  const transcodeToBlob = useCallback((format: ExportFormat, quality: number): Promise<Blob | null> => {
    const src = previewImage;
    if (!src) return Promise.resolve(null);
    const meta = EXPORT_FORMATS[format];
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        if (format === "jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((b) => resolve(b), meta.mime, meta.lossy ? quality : undefined);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }, [previewImage]);

  // 防抖估算导出体积：格式/质量变化时重新 toBlob 取真实字节数。
  useEffect(() => {
    if (!previewImage) { setExportEstimate(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const blob = await transcodeToBlob(exportFormat, exportQuality);
      if (!cancelled) setExportEstimate(blob ? blob.size : null);
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [previewImage, exportFormat, exportQuality, transcodeToBlob]);

  const exportImage = useCallback(async () => {
    if (exporting || !previewImage) return;
    setExporting(true);
    try {
      const meta = EXPORT_FORMATS[exportFormat];
      const blob = await transcodeToBlob(exportFormat, exportQuality);
      if (!blob) { toast("导出失败：无法编码图片", "error"); return; }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const defaultName = withExportExt(previewInfo?.file_name || "image.png", exportFormat);
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: `${meta.label} 图片`, extensions: [meta.ext] }],
      });
      if (!path) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, bytes);
      toast(`已导出 ${meta.label}`, "success");
    } catch (e) {
      toast("导出失败: " + (e instanceof Error ? e.message : String(e)), "error");
    } finally {
      setExporting(false);
    }
  }, [exporting, previewImage, exportFormat, exportQuality, previewInfo, transcodeToBlob, toast]);

  // ========== 裁剪（③） ==========

  const MIN_CROP = 10;

  // 将当前预览图按 scale/rotation 烘到 canvas，返回 canvas + 显示尺寸（viewport 坐标空间）。
  // 裁剪选区基于该空间，因此 视口内所见 = canvas 内所取。
  const bakeImage = useCallback((): Promise<{ canvas: HTMLCanvasElement; displayW: number; displayH: number } | null> => {
    if (!previewImage) return Promise.resolve(null);
    const vp = viewportRef.current;
    if (!vp) return Promise.resolve(null);
    const vpRect = vp.getBoundingClientRect();
    const w = vpRect.width, h = vpRect.height;
    if (w <= 0 || h <= 0) return Promise.resolve(null);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    return new Promise<{ canvas: HTMLCanvasElement; displayW: number; displayH: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = previewScale;
        const rot = previewRotation * Math.PI / 180;
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rot);
        ctx.drawImage(img, -img.naturalWidth * scale / 2, -img.naturalHeight * scale / 2, img.naturalWidth * scale, img.naturalHeight * scale);
        ctx.restore();
        resolve({ canvas, displayW: w, displayH: h });
      };
      img.onerror = () => resolve(null);
      img.src = previewImage;
    });
  }, [previewImage, previewScale, previewRotation]);

  const handleCropMouseDown = useCallback((e: React.MouseEvent) => {
    if (!cropMode || !viewportRef.current) return;
    const vpRect = viewportRef.current.getBoundingClientRect();
    const mx = e.clientX - vpRect.left;
    const my = e.clientY - vpRect.top;
    const r = cropRect;
    const HIT = 10;
    if (r) {
      // 8 个手柄：角 + 边中点
      const hs: Record<string, [number, number]> = {
        tl: [r.x, r.y], tc: [r.x + r.w / 2, r.y], tr: [r.x + r.w, r.y],
        ml: [r.x, r.y + r.h / 2], mr: [r.x + r.w, r.y + r.h / 2],
        bl: [r.x, r.y + r.h], bc: [r.x + r.w / 2, r.y + r.h], br: [r.x + r.w, r.y + r.h],
      };
      for (const [name, [hx, hy]] of Object.entries(hs)) {
        if (Math.abs(mx - hx) <= HIT && Math.abs(my - hy) <= HIT) {
          e.stopPropagation();
          cropDragRef.current = { mode: "resize", handle: name, sx: mx, sy: my, start: { ...r } };
          return;
        }
      }
      // 内部移动
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        e.stopPropagation();
        cropDragRef.current = { mode: "move", handle: "", sx: mx, sy: my, start: { ...r } };
        return;
      }
    }
    // 空白区拖拽重画
    e.stopPropagation();
    const initRect = { x: mx, y: my, w: 1, h: 1 };
    setCropRect(initRect);
    cropDragRef.current = { mode: "draw", handle: "", sx: mx, sy: my, start: initRect };
  }, [cropMode, cropRect]);

  const handleCropMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = cropDragRef.current;
    if (!drag || !viewportRef.current) return;
    const vpRect = viewportRef.current.getBoundingClientRect();
    const mx = e.clientX - vpRect.left;
    const my = e.clientY - vpRect.top;
    const dx = mx - drag.sx;
    const dy = my - drag.sy;
    const W = vpRect.width, H = vpRect.height;
    const { start } = drag;

    if (drag.mode === "move") {
      let nx = start.x + dx, ny = start.y + dy;
      nx = Math.max(0, Math.min(W - start.w, nx));
      ny = Math.max(0, Math.min(H - start.h, ny));
      setCropRect({ x: nx, y: ny, w: start.w, h: start.h });
      return;
    }
    if (drag.mode === "resize") {
      let x = start.x, y = start.y, w = start.w, h = start.h;
      const hdl = drag.handle;
      if (hdl.includes("l")) { x = start.x + dx; w = start.w - dx; }
      if (hdl.includes("r")) { w = start.w + dx; }
      if (hdl.includes("t")) { y = start.y + dy; h = start.h - dy; }
      if (hdl.includes("b")) { h = start.h + dy; }
      if (w < MIN_CROP) { if (hdl.includes("l")) x = start.x + start.w - MIN_CROP; w = MIN_CROP; }
      if (h < MIN_CROP) { if (hdl.includes("t")) y = start.y + start.h - MIN_CROP; h = MIN_CROP; }
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > W) w = W - x;
      if (y + h > H) h = H - y;
      setCropRect({ x, y, w, h });
      return;
    }
    // draw：左上角为起点，右下角为当前鼠标
    const x1 = drag.sx, y1 = drag.sy, x2 = mx, y2 = my;
    let rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    let rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rx < 0) { rw += rx; rx = 0; }
    if (ry < 0) { rh += ry; ry = 0; }
    if (rx + rw > W) rw = W - rx;
    if (ry + rh > H) rh = H - ry;
    if (rw < MIN_CROP) rw = MIN_CROP;
    if (rh < MIN_CROP) rh = MIN_CROP;
    setCropRect({ x: rx, y: ry, w: rw, h: rh });
  }, []);

  const handleCropMouseUp = useCallback(() => {
    cropDragRef.current = null;
  }, []);

  const confirmCrop = useCallback(async () => {
    if (!cropRect || !previewImage || !viewportRef.current) return;
    const baked = await bakeImage();
    if (!baked) { toast("裁剪失败：无法渲染图片", "error"); return; }
    const { canvas, displayW, displayH } = baked;
    const sx = Math.max(0, Math.min(displayW, cropRect.x));
    const sy = Math.max(0, Math.min(displayH, cropRect.y));
    const sw = Math.max(1, Math.min(displayW - sx, cropRect.w));
    const sh = Math.max(1, Math.min(displayH - sy, cropRect.h));
    const out = document.createElement("canvas");
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    const octx = out.getContext("2d");
    if (!octx) { toast("裁剪失败", "error"); return; }
    octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = out.toDataURL("image/png");
    const originalForRestore = cropOriginal ?? previewImage;
    setCropOriginal(originalForRestore);
    setPreviewImage(dataUrl);
    setPreviewInfo((prev) => prev ? { ...prev, width: out.width, height: out.height, size_str: formatBytes(out.toDataURL("image/png").length) } : prev);
    setCropMode(false);
    setCropRect(null);
    toast("裁剪完成", "success");
  }, [cropRect, previewImage, cropOriginal, bakeImage, toast]);

  const cancelCrop = useCallback(() => {
    setCropMode(false);
    setCropRect(null);
  }, []);

  const restoreOriginal = useCallback(() => {
    if (!cropOriginal) return;
    setPreviewImage(cropOriginal);
    setCropOriginal(null);
    setPreviewInfo(null); // 让 openImagePreview 重新拉取信息，或由外部重新加载
    toast("已还原原图", "success");
  }, [cropOriginal, toast]);

  return {
    previewImage, previewInfo, previewLoading,
    previewScale, previewRotation, previewOffset, isPanning,
    previewContentRef, viewportRef, previewItem,
    ocrResult, ocrLoading, ocrActive, selectedWordIndices, isSelecting, selRect,
    exportFormat, exportQuality, exportEstimate, exporting,
    cropMode, cropRect, cropOriginal,
    openImagePreview, closePreview,
    setExportFormat, setExportQuality, exportImage,
    setCropMode, setCropRect,
    handleCropMouseDown, handleCropMouseMove, handleCropMouseUp,
    confirmCrop, cancelCrop, restoreOriginal,
    setPreviewScale, setPreviewRotation, setPreviewOffset, setSelectedWordIndices,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    handleOcrRecognize, toggleOcrOverlay, getSelectedOcrTexts,
    handleOcrWordClick, handleOcrSelectStart, handleOcrSelectMove, handleOcrSelectEnd,
    handlePinImage,
  };
}
