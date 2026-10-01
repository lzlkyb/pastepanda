/**
 * useImagePreview — 图片预览 + OCR 逻辑（从 CardList.tsx 提取）
 *
 * 管理：预览状态（适应窗口/缩放/旋转/偏移/平移）、OCR 识别与框选。
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HistoryItem } from "@/stores/appStore";
import { getImageThumbnail, getImageDataUrl, getImageInfo, getImageBase64 } from "@/lib/api";
import { useToast } from "@/components/Toast";
import {
  type ExportFormat,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_QUALITY,
  withExportExt,
  formatBytes,
} from "@/lib/imageFormat";
import { linesAsRowWords } from "@/lib/screenshot/ocrTable";
import { clampImageZoom, imageFitScale } from "@/lib/imagePreviewFit";

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
  fitScale: number;
  isFitMode: boolean;
  previewRotation: number;
  previewOffset: { x: number; y: number };
  isPanning: boolean;
  previewContentRef: React.MutableRefObject<string | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  // OCR 状态
  ocrResult: OcrResultData | null;
  ocrLoading: boolean;
  ocrActive: boolean;
  /** 列表已持久化的 OCR 全文（null = 这张图还没识别过）。与 ocrResult 互补：
     全文展示/复制用它（零成本），选词才需要 ocrResult 的词框。 */
  ocrCachedText: string | null;
  /** 浮出面板互斥（'ocr' 摘要/全文 | 'export' 导出 | 'codes' 码 | null 收起） */
  activePanel: "ocr" | "export" | "codes" | null;
  setActivePanel: React.Dispatch<React.SetStateAction<"ocr" | "export" | "codes" | null>>;
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
  /** 裁剪模式开关（含互斥：进裁剪退出 OCR 选词并清选区，见实现处注释） */
  toggleCropMode: () => void;
  handleCropMouseDown: (e: React.MouseEvent) => void;
  handleCropMouseMove: (e: React.MouseEvent) => void;
  handleCropMouseUp: () => void;
  confirmCrop: () => Promise<void>;
  cancelCrop: () => void;
  restoreOriginal: () => void;
  fitPreview: () => void;
  zoomPreview: (factor: number) => void;
  showActualSize: () => void;
  rotatePreview: () => void;
  onPreviewImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
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
  /** 微信借鉴⑤：按词框相邻判断拼接（相邻不加空格、换行加空格） */
  getSelectedOcrJoined: () => string;
  handleOcrWordClick: (lineIdx: number, wordIdx: number, e: React.MouseEvent) => void;
  handleOcrSelectStart: (e: React.MouseEvent) => void;
  handleOcrSelectMove: (e: MouseEvent) => void; // window 级原生事件（拖出视口不中断）
  handleOcrSelectEnd: () => void;
  handlePinImage: () => void;
}

// 坐标版 OCR（词框）的会话内缓存（path → 结果）。
// 词框只有「图上选词」需要；没有它，同一条图每次进详情点选词都要重跑一遍
// PP-OCR 引擎——列表侧 useCardOcr 的 memCache 同款手法（设计稿「零二次识别」）。
// 上限 50 条，避免连续查看大量图片后无限增长。
const ocrWordsCache = new Map<string, OcrResultData>();

export function useImagePreview(): UseImagePreviewReturn {
  const { toast } = useToast();

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  // 当前预览的条目。留着是为了“框选一块 → 拿这段文字去变换”能把它交给枢纽
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [isFitMode, setIsFitMode] = useState(true);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // OCR 状态
  const [ocrResult, setOcrResult] = useState<OcrResultData | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrActive, setOcrActive] = useState(false);
  /** 列表懒识别已持久化的全文（image_ocr_cache）。「全文查看/复制」用它零成本带出；
     词框坐标（ocrResult）只有「图上选词」需要，按需现跑。 */
  const [ocrCachedText, setOcrCachedText] = useState<string | null>(null);
  /** 浮出面板互斥（设计稿：同时最多一个）：null=全收起。 */
  const [activePanel, setActivePanel] = useState<"ocr" | "export" | "codes" | null>(null);
  const [selectedWordIndices, setSelectedWordIndices] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  /** isSelecting 的 ref 镜像：window 原生监听里读它（state 闭包在重渲染前是旧值，
   *  会吞掉 mousedown 后第一批 mousemove；ref 永远最新，实时选词不依赖 React 渲染时序） */
  const isSelectingRef = useRef(false);
  /** rAF 节流：mousemove 高频触发，但 setState + 全量重渲染几百个词框 DOM 很贵，
   *  每帧最多处理一次，避免拖动时主线程卡死（表现为"选词没反应"） */
  const selectRafRef = useRef<number | null>(null);
  const lastSelRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
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
  /** 微信式选词：本次 mousedown 是否已产生位移（区分"单击点选"与"拖拽框选"） */
  const selectDraggedRef = useRef(false);
  /** 本次拖拽是否 Ctrl/Meta 追加模式（实时命中时保留已选，不替换） */
  const selectAppendRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageDimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const fitScaleRef = useRef(1);
  const fitModeRef = useRef(true);
  // 使用 ref 存储预览状态，避免 closePreview 闭包导致 ESC 监听器频繁重新注册
  const previewStateRef = useRef({ scale: 1, rotation: 0, offset: { x: 0, y: 0 } });
  // 当前预览的图片 content 路径（异步加载与复制时校验当前图片）
  const previewContentRef = useRef<string | null>(null);

  // 同步预览状态到 ref
  previewStateRef.current = { scale: previewScale, rotation: previewRotation, offset: previewOffset };

  const calculateFit = useCallback((rotation: number) => {
    const image = imageDimensionsRef.current;
    const viewport = viewportRef.current;
    if (!image || !viewport) return 1;
    return imageFitScale(image.width, image.height, viewport.clientWidth, viewport.clientHeight, rotation);
  }, []);

  const fitPreviewAtRotation = useCallback((rotation: number) => {
    const scale = calculateFit(rotation);
    fitScaleRef.current = scale;
    fitModeRef.current = true;
    setFitScale(scale);
    setIsFitMode(true);
    setPreviewScale(scale);
    setPreviewOffset({ x: 0, y: 0 });
  }, [calculateFit]);

  const fitPreview = useCallback(() => fitPreviewAtRotation(previewStateRef.current.rotation), [fitPreviewAtRotation]);

  const onPreviewImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    const hadImage = imageDimensionsRef.current != null;
    const oldFit = fitScaleRef.current;
    imageDimensionsRef.current = { width: naturalWidth, height: naturalHeight };
    const nextFit = calculateFit(previewStateRef.current.rotation);
    fitScaleRef.current = nextFit;
    setFitScale(nextFit);
    if (fitModeRef.current) {
      setPreviewScale(nextFit);
      setPreviewOffset({ x: 0, y: 0 });
    } else if (hadImage && oldFit > 0) {
      // 缩略图换原图时按适应比例换算，保留用户已放大的视觉倍率。
      setPreviewScale((scale) => clampImageZoom(scale * nextFit / oldFit, nextFit));
    }
  }, [calculateFit]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!previewImage || !viewport) return;
    const observer = new ResizeObserver(() => {
      const scale = calculateFit(previewStateRef.current.rotation);
      fitScaleRef.current = scale;
      setFitScale(scale);
      if (fitModeRef.current) {
        setPreviewScale(scale);
        setPreviewOffset({ x: 0, y: 0 });
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [previewImage, calculateFit]);

  const zoomPreview = useCallback((factor: number) => {
    const prev = previewStateRef.current;
    const next = clampImageZoom(prev.scale * factor, fitScaleRef.current);
    if (next === prev.scale) return;
    fitModeRef.current = false;
    setIsFitMode(false);
    setPreviewScale(next);
    const ratio = next / prev.scale;
    setPreviewOffset({ x: prev.offset.x * ratio, y: prev.offset.y * ratio });
  }, []);

  const showActualSize = useCallback(() => {
    fitModeRef.current = false;
    setIsFitMode(false);
    setPreviewScale(1);
    setPreviewOffset({ x: 0, y: 0 });
  }, []);

  const rotatePreview = useCallback(() => {
    const rotation = (previewStateRef.current.rotation + 90) % 360;
    setPreviewRotation(rotation);
    fitPreviewAtRotation(rotation);
  }, [fitPreviewAtRotation]);

  const openImagePreview = useCallback(async (item: HistoryItem) => {
    const requestContent = item.content || null;
    setPreviewImage(null);
    setPreviewInfo(null);
    setPreviewItem(item);
    previewContentRef.current = requestContent;

    // 重置 OCR 状态。❗ 全文从列表缓存直接带出（item.ocr_text，列表可视卡片早已
    // 懒识别入库）——设计稿「零二次识别」：进场即亮摘要条，不再等用户点识别。
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());
    setOcrCachedText(item.ocr_text ?? null);
    setActivePanel(item.ocr_text != null ? "ocr" : null);
    setExportEstimate(null);
    setCropMode(false);
    setCropRect(null);
    setCropOriginal(null);

    // 每次打开先适应窗口；不能沿用上次的倍率，否则大图再次打开仍可能被裁掉。
    imageDimensionsRef.current = null;
    fitScaleRef.current = 1;
    fitModeRef.current = true;
    setFitScale(1);
    setIsFitMode(true);
    setPreviewScale(1);
    setPreviewRotation(0);
    setPreviewOffset({ x: 0, y: 0 });

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
    previewContentRef.current = null;
    imageDimensionsRef.current = null;
    fitScaleRef.current = 1;
    fitModeRef.current = true;
    setPreviewImage(null);
    setPreviewInfo(null);
    setPreviewItem(null);
    setPreviewScale(1);
    setFitScale(1);
    setIsFitMode(true);
    setPreviewRotation(0);
    setPreviewOffset({ x: 0, y: 0 });
    setOcrResult(null);
    setOcrActive(false);
    setSelectedWordIndices(new Set());
    setOcrCachedText(null);
    setActivePanel(null);
    setCropMode(false);
    setCropRect(null);
    setCropOriginal(null);
  }, []);

  // ESC 键关闭预览 / 清除 OCR 选择
  useEffect(() => {
    if (!previewImage && !previewLoading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 两级取消（§17.6）：面板/裁剪/选词先逐步退回查看态，最后一级才退出查看层。
        // 互斥链与模式本身一致：cropMode → 已选词 → 选词态 → 浮出面板 → 关闭。
        if (cropMode) {
          setCropMode(false);
          setCropRect(null);
        } else if (ocrActive && selectedWordIndices.size > 0) {
          setSelectedWordIndices(new Set());
        } else if (ocrActive) {
          setOcrActive(false);
        } else if (activePanel) {
          setActivePanel(null);
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
        case '0': fitPreview(); break;
        case 'r': case 'R': rotatePreview(); break;
        case '+': case '=': zoomPreview(1.25); break;
        case '-': zoomPreview(0.8); break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // 不能补 getSelectedOcrTexts：它定义在本 effect 之后，写进依赖数组会 TDZ ReferenceError
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImage, previewLoading, closePreview, ocrActive, selectedWordIndices, cropMode, activePanel, toast, fitPreview, rotatePreview, zoomPreview]);

  // 滚轮 = 缩放，以光标为中心（设计稿交互规格；对齐看图器肌肉记忆，替代旧「滚轮平移」）。
  // 锚点换算：容器 transform = translate(offset)·S(s)（rotation 与均匀缩放可交换，视口坐标下消去），
  // 要让光标下的图像点不动：offset' = p − (s'/s)·(p − offset)，p 为光标相对视口中心。
  // 读 previewStateRef 而非 setState 闭包：连续滚轮间不用等重渲染（同 pan 的 ref 手法）。
  const handlePreviewWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const prev = previewStateRef.current;
    const next = clampImageZoom(prev.scale * (e.deltaY > 0 ? 0.9 : 1.1), fitScaleRef.current);
    if (next === prev.scale) return;
    fitModeRef.current = false;
    setIsFitMode(false);
    const vp = viewportRef.current;
    if (!vp) { setPreviewScale(next); return; }
    const rect = vp.getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const k = next / prev.scale;
    setPreviewScale(next);
    setPreviewOffset({ x: px - k * (px - prev.offset.x), y: py - k * (py - prev.offset.y) });
  }, []);

  // 拖拽平移只在大于适应倍率后可用（适应窗口时图片完整可见，无需拖动）。
  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || previewStateRef.current.scale <= fitScaleRef.current * 1.001) return;
    e.preventDefault();
    setIsPanning(true);
    panStartRef.current = { x: e.clientX, y: e.clientY, offsetX: previewOffset.x, offsetY: previewOffset.y };
  }, [previewOffset]);

  const handlePanMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const vp = viewportRef.current;
    const image = imageDimensionsRef.current;
    if (!vp || !image) return;
    const { scale, rotation } = previewStateRef.current;
    const sideways = rotation % 180 === 90;
    const displayWidth = (sideways ? image.height : image.width) * scale;
    const displayHeight = (sideways ? image.width : image.height) * scale;
    const maxX = Math.max(0, (displayWidth - vp.clientWidth) / 2);
    const maxY = Math.max(0, (displayHeight - vp.clientHeight) / 2);
    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));
    setPreviewOffset({
      x: clamp(panStartRef.current.offsetX + (e.clientX - panStartRef.current.x), maxX),
      y: clamp(panStartRef.current.offsetY + (e.clientY - panStartRef.current.y), maxY),
    });
  }, [isPanning]);

  const handlePanEnd = useCallback(() => {
    setIsPanning(false);
  }, []);

  // ========== OCR 相关 ==========

  const handleOcrRecognize = useCallback(async () => {
    const path = previewContentRef.current;
    if (!path) return;
    // 会话内缓存命中直接用（重复打开同一条图不重跑引擎）。
    const cached = ocrWordsCache.get(path);
    if (cached) {
      setOcrResult(cached);
      setOcrActive(true);
      setSelectedWordIndices(new Set());
      return;
    }
    setOcrLoading(true);
    try {
      const result = await invoke<OcrResultData>("ocr_image", { path });
      // 后端已逐字化（每行 N 个字符框）；图片预览保持「点一行选整行」的旧交互，
      // 把逐字框聚合回行级单框（linesAsRowWords 对已是整行单框的行幂等）。
      const processed: OcrResultData = { ...result, lines: linesAsRowWords(result.lines) };
      ocrWordsCache.set(path, processed);
      // 上限 50 条，淘汰最旧。
      if (ocrWordsCache.size > 50) {
        const first = ocrWordsCache.keys().next().value;
        if (first != null) ocrWordsCache.delete(first);
      }
      setOcrResult(processed);
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
      // 模式互斥：选词与裁剪共用视口鼠标手势，叠加会 mousedown 双触发、词框拦截裁剪点击。
      // 进入选词前退出裁剪（Esc 的优先级链 cropMode→选区→OCR 也是同一语义）。
      setCropMode(false);
      setCropRect(null);
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

  /** 微信借鉴⑤：按词框坐标相邻判断拼接 —— 同一行相邻的词不加空格、换行/跨行加空格，
   *  替代固定 join(' ')（连选时不会出现「深圳市 南山区 科技园路 1号」这类硬空格）。 */
  const getSelectedOcrJoined = useCallback((): string => {
    if (!ocrResult) return "";
    const sel: { li: number; wi: number; word: OcrWordInfo }[] = [];
    selectedWordIndices.forEach((key) => {
      const [li, wi] = key.split("-").map(Number);
      const word = ocrResult.lines[li]?.words[wi];
      if (word) sel.push({ li, wi, word });
    });
    sel.sort((a, b) => a.li - b.li || a.wi - b.wi);
    let out = "";
    let prev: { li: number; word: OcrWordInfo } | null = null;
    for (const s of sel) {
      if (!prev) {
        out = s.word.text;
      } else {
        const sameLine = s.li === prev.li;
        // 相邻判定：同一行，且当前词左缘未超过前词右缘 + 半字高容差（OCR 词框常略有缝隙/重叠）
        const prevRight = prev.word.x + prev.word.width;
        const gap = s.word.x - prevRight;
        const adjacent = sameLine && gap <= Math.max(10, prev.word.height * 0.6) && gap > -prev.word.width;
        out += (adjacent ? "" : " ") + s.word.text;
      }
      prev = s;
    }
    return out;
  }, [ocrResult, selectedWordIndices]);

  const handleOcrWordClick = useCallback((lineIdx: number, wordIdx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    // 拖拽结束落在词框上会带出一个 click，忽略它（框选结果已由实时命中维护）
    if (selectDraggedRef.current) return;
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

  // ===== 微信式选词（A+B）：起点可落词框、move/up 走 window、拖动过程实时命中高亮 =====

  /** 把当前选区（viewport 坐标）与词框 DOM（渲染后实时位置，含 transform）做重叠测试。
   *  词框与图片同处一个 transform 容器 → 缩放/平移/旋转/动画全程对齐，命中永不漂移。 */
  const computeHitWords = useCallback((sel: { x: number; y: number; w: number; h: number }): Set<string> => {
    const hit = new Set<string>();
    const viewport = viewportRef.current;
    if (!viewport) return hit;
    const vpRect = viewport.getBoundingClientRect();
    const boxes = viewport.querySelectorAll<HTMLElement>("[data-ocr-word-box]");
    for (const box of boxes) {
      const key = box.dataset.key;
      if (!key) continue;
      const r = box.getBoundingClientRect();
      const wx = r.left - vpRect.left;
      const wy = r.top - vpRect.top;
      const overlap = !(wx + r.width < sel.x || wx > sel.x + sel.w ||
                        wy + r.height < sel.y || wy > sel.y + sel.h);
      if (overlap) hit.add(key);
    }
    return hit;
  }, []);

  const handleOcrSelectStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const viewport = e.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    selectDraggedRef.current = false;
    selectAppendRef.current = !!(e.ctrlKey || e.metaKey);
    isSelectingRef.current = true;
    setIsSelecting(true);
    selStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setSelRect({ x: selStartRef.current.x, y: selStartRef.current.y, w: 0, h: 0 });
    if (!selectAppendRef.current) {
      setSelectedWordIndices(new Set());
    }
  }, []);

  const handleOcrSelectMove = useCallback((e: MouseEvent) => {
    // 读 ref 而非 state：window 监听绑定后即使 React 还没重渲染，也能立即响应拖动
    if (!isSelectingRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // 位移超过阈值才算"拖拽"（区分单击点选：单击时 selectDraggedRef 保持 false，由 click 走点选）
    if (Math.abs(cx - selStartRef.current.x) > 3 || Math.abs(cy - selStartRef.current.y) > 3) {
      selectDraggedRef.current = true;
    }
    const x = Math.min(selStartRef.current.x, cx);
    const y = Math.min(selStartRef.current.y, cy);
    const w = Math.abs(cx - selStartRef.current.x);
    const h = Math.abs(cy - selStartRef.current.y);
    lastSelRectRef.current = { x, y, w, h };
    // rAF 节流：每帧最多一次 setState + 命中测试（词框多时避免主线程卡死）
    if (selectRafRef.current == null) {
      selectRafRef.current = requestAnimationFrame(() => {
        selectRafRef.current = null;
        const sel = lastSelRectRef.current;
        if (!sel) return;
        setSelRect(sel);
        // 实时命中：拖动过程就高亮命中词，不必等松开（微信手感）
        if (selectDraggedRef.current && sel.w > 0 && sel.h > 0) {
          const hit = computeHitWords(sel);
          setSelectedWordIndices(prev => {
            if (selectAppendRef.current) {
              const next = new Set(prev);
              hit.forEach((k) => next.add(k));
              return next;
            }
            return hit;
          });
        }
      });
    }
  }, [computeHitWords]);

  const handleOcrSelectEnd = useCallback(() => {
    isSelectingRef.current = false;
    setIsSelecting(false);
    if (selectRafRef.current != null) {
      cancelAnimationFrame(selectRafRef.current);
      selectRafRef.current = null;
    }
    setSelRect(null);
    // 选择结果已由 move 实时维护，这里只收尾（勿再重算，避免与实时命中不一致）
  }, []);

  // A+B：OCR 框选 move/up 挂 window 级监听 —— 拖出视口不中断、在视口外松开也能收尾
  // （对比之前挂在 viewport 上：onMouseLeave 直接掐断框选、视口外松手收不到 mouseup）
  useEffect(() => {
    if (!ocrActive) return;
    const onMove = (e: MouseEvent) => handleOcrSelectMove(e);
    const onUp = () => handleOcrSelectEnd();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [ocrActive, handleOcrSelectMove, handleOcrSelectEnd]);

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

  // 取得「干净」图片源：previewImage 通常是 convertFileSrc 产生的 asset://（或
  // https://asset.localhost）URL，跨域加载到 canvas 会污染画布，导致 toDataURL/toBlob
  // 抛 SecurityError 或返回 null（确认裁剪 / 导出均会失败）。因此优先用已是 data: 的同源
  // 干净源（如二次裁剪结果），否则走 getImageBase64（Rust 返回 base64 data URL）拿干净源。
  const getCleanImageSrc = useCallback(async (): Promise<string | null> => {
    if (!previewImage) return null;
    if (/^data:/i.test(previewImage)) return previewImage;
    if (previewItem?.content) {
      const b64 = await getImageBase64(previewItem.content).catch(() => "");
      if (b64) return b64;
    }
    return null;
  }, [previewImage, previewItem]);

  // 将当前预览图按目标格式/质量转码为 Blob（按原图自然尺寸绘制）。
  // jpeg 无透明通道，先铺白底避免透明区域变黑。
  // 注意：必须用「干净」同源源（getCleanImageSrc），asset:// 会污染画布导致 toBlob 返回 null。
  const transcodeToBlob = useCallback(async (format: ExportFormat, quality: number): Promise<Blob | null> => {
    const src = await getCleanImageSrc();
    if (!src) return null;
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
  }, [getCleanImageSrc]);

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
  const bakeImage = useCallback(async (): Promise<{ canvas: HTMLCanvasElement; displayW: number; displayH: number } | null> => {
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
    const src = await getCleanImageSrc();
    if (!src) return Promise.resolve(null);
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
      img.src = src;
    });
  }, [previewImage, previewScale, previewRotation, getCleanImageSrc]);

  /** 裁剪模式开关（含互斥）：进入裁剪前退出 OCR 选词并清空选区。
   *  选词与裁剪共用视口鼠标手势，叠加时词框层（pointerEvents:auto、z-index 高于
   *  cropBackdrop）会拦掉点在词框上的裁剪 mousedown，裁剪框画不出来——必须二选一。 */
  const toggleCropMode = useCallback(() => {
    const next = !cropMode;
    if (next) {
      setOcrActive(false);
      setSelectedWordIndices(new Set());
    }
    setCropMode(next);
    setCropRect(null);
  }, [cropMode]);

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
    try {
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
      fitModeRef.current = true;
      setIsFitMode(true);
      setPreviewImage(dataUrl);
      setPreviewInfo((prev) => prev ? { ...prev, width: out.width, height: out.height, size_str: formatBytes(out.toDataURL("image/png").length) } : prev);
      setCropMode(false);
      setCropRect(null);
      toast("裁剪完成", "success");
    } catch (e) {
      console.error("确认裁剪失败", e);
      toast("裁剪失败，请重试", "error");
    }
  }, [cropRect, previewImage, cropOriginal, bakeImage, toast]);

  const cancelCrop = useCallback(() => {
    setCropMode(false);
    setCropRect(null);
  }, []);

  const restoreOriginal = useCallback(() => {
    if (!cropOriginal) return;
    fitModeRef.current = true;
    setIsFitMode(true);
    setPreviewImage(cropOriginal);
    setCropOriginal(null);
    setPreviewInfo(null); // 让 openImagePreview 重新拉取信息，或由外部重新加载
    toast("已还原原图", "success");
  }, [cropOriginal, toast]);

  return {
    previewImage, previewInfo, previewLoading,
    previewScale, fitScale, isFitMode, previewRotation, previewOffset, isPanning,
    previewContentRef, viewportRef, previewItem,
    ocrResult, ocrLoading, ocrActive, ocrCachedText, activePanel, setActivePanel,
    selectedWordIndices, isSelecting, selRect,
    exportFormat, exportQuality, exportEstimate, exporting,
    cropMode, cropRect, cropOriginal,
    openImagePreview, closePreview,
    setExportFormat, setExportQuality, exportImage,
    setCropMode, setCropRect, toggleCropMode,
    handleCropMouseDown, handleCropMouseMove, handleCropMouseUp,
    confirmCrop, cancelCrop, restoreOriginal,
    fitPreview, zoomPreview, showActualSize, rotatePreview, onPreviewImageLoad, setSelectedWordIndices,
    handlePreviewWheel, handlePanStart, handlePanMove, handlePanEnd,
    handleOcrRecognize, toggleOcrOverlay, getSelectedOcrTexts, getSelectedOcrJoined,
    handleOcrWordClick, handleOcrSelectStart, handleOcrSelectMove, handleOcrSelectEnd,
    handlePinImage,
  };
}
