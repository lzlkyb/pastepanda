/**
 * ScreenshotOverlay — 截图标注全流程组件（选区 → 标注 → OCR 融入 → 结果出口）。
 *
 * 坐标系约定（与后端 screenshot.rs 一致）：
 * - 全程物理像素；前端 CSS 显示尺寸 = 物理 / devicePixelRatio；
 * - 鼠标 CSS 坐标 × dpr = 物理坐标；
 * - 标注画布 bitmap = 选区物理尺寸，CSS 尺寸 = 物理 / dpr，内部绘制用物理坐标；
 * - OCR 行框坐标相对选区图（合成后的图），与标注画布同坐标系，天然对齐。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ocrImage, type OcrResult } from "@/lib/api/images";
import { aiListActions, aiRun, type AiActionMeta, type AiRunResponse } from "@/lib/api/ai";
import { chainList, type ChainDef } from "@/lib/api/chains";
import { runChain } from "@/lib/chains/registry";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { useAiStatus } from "@/hooks/useAiStatus";
import type { Chain, ChainRunResult } from "@/lib/chains/types";
import { logger } from "@/lib/logger";
// 纯计算已抽到 lib/screenshot/（规则 7）——那里才能写回归测试：
// 坐标换算与磁吸曾各藏过一个真 bug，长截图重叠匹配曾把 G/B 通道索引写错。
import {
  applyMagnet,
  eraseHits,
  pointHitAnnot,
  toLocalRect,
  toScreenPt,
} from "@/lib/screenshot/geometry";
import { findOverlapRows, framesAlike } from "@/lib/screenshot/stitch";
import { csvEscape, ocrToTable } from "@/lib/screenshot/ocrTable";
import { detectSensitiveText } from "@/lib/screenshot/sensitive";
import type {
  Annotation,
  Rect,
  ScreenInfo,
  SnapRect,
  ToolId,
} from "@/lib/screenshot/types";

/* ===== 类型（仅本组件用的那几个；共享类型在 lib/screenshot/types） ===== */

/** AI 弹层运行状态（三态 + 确认） */
interface PopRun {
  status: "idle" | "running" | "ok" | "error" | "confirm";
  content?: string;
  message?: string;
  meta?: string;
  confirmReason?: string;
}

type Phase = "select" | "annotate" | "result";

/* ===== 常量 ===== */
const TOOLS: { id: ToolId; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "rect", label: "矩形", key: "1", icon: <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> },
  { id: "ellipse", label: "椭圆", key: "2", icon: <svg viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="6" ry="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> },
  { id: "arrow", label: "箭头", key: "3", icon: <svg viewBox="0 0 16 16"><path d="M2 13L11 4" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 4H12V8.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> },
  { id: "pen", label: "画笔", key: "4", icon: <svg viewBox="0 0 16 16"><path d="M3 13l4-1 6.5-6.5a1.4 1.4 0 0 0 0-2L11.5 1.5a1.4 1.4 0 0 0-2 0L3 8l-1 4z" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg> },
  { id: "highlight", label: "高亮", key: "5", icon: <svg viewBox="0 0 16 16"><rect x="2" y="8" width="12" height="4" rx="1" fill="currentColor" opacity=".7" /></svg> },
  { id: "mosaic", label: "马赛克", key: "6", icon: <svg viewBox="0 0 16 16"><g fill="currentColor" opacity=".75"><rect x="2" y="2" width="4" height="4" /><rect x="8" y="2" width="4" height="4" /><rect x="5" y="5" width="4" height="4" /><rect x="2" y="8" width="4" height="4" /><rect x="8" y="8" width="4" height="4" /></g></svg> },
  { id: "text", label: "文字", key: "7", icon: <svg viewBox="0 0 16 16"><path d="M3 3.5h10M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg> },
  { id: "number", label: "序号", key: "8", icon: <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><text x="8" y="9.2" textAnchor="middle" fontSize="7" fontWeight="600" fill="currentColor">1</text></svg> },
  { id: "blur", label: "模糊", key: "9", icon: <svg viewBox="0 0 16 16"><circle cx="6" cy="5" r="3.4" fill="currentColor" opacity=".35" /><circle cx="11" cy="8" r="2.6" fill="currentColor" opacity=".55" /><circle cx="5" cy="11.5" r="2.2" fill="currentColor" opacity=".4" /></svg> },
  { id: "eraser", label: "橡皮擦", key: "0", icon: <svg viewBox="0 0 16 16"><path d="M9.5 3.5l3 3L7 12H3.5V8.5l6-5z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2.5 12.5h7" stroke="currentColor" strokeWidth="1.6" /></svg> },
  { id: "picker", label: "吸管取色", key: "", icon: <svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L7 12H4.5V9.5l6-7z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M9 4l3 3" stroke="currentColor" strokeWidth="1.4" /></svg> },
];

const COLORS = ["#ef4444", "#3b9eff", "#facc15", "#22c55e", "#1f2937"];
const LINE_WIDTH = 3;
const TEXT_SIZE = 18;
/* 放大镜参数（物理像素）：采样半径 30px，4 倍放大 → 240×240 画布 */
const MAG_R = 30;
const MAG_ZOOM = 4;
const MAG_SIZE = MAG_R * 2 * MAG_ZOOM;
/* 取色探针 canvas（模块级复用，避免拖选高频 GC） */
let probeCanvas: HTMLCanvasElement | null = null;

/** 链里有没有会把内容发到云端的步骤。判据沿用 chains/registry 的 riskOf（remote → "network"），
 *  不在这里另写一套——规则 11.1。纯本地链（全是 local 步骤）不受 AI 开关约束，
 *  规则 16 第 4 条明说本地能力不算 AI 功能。 */
function chainNeedsAi(c: ChainDef): boolean {
  return c.steps.some((s) => s.risk === "network");
}

let idSeq = 1;
const nextId = () => idSeq++;

/* ===== 标注绘制（物理坐标，供 annotCanvas 与合成共用） =====
 * baseImg：可选底图（全屏物理像素）；offX/offY：选区在底图中的偏移——
 * 标注元素坐标是"选区本地"，马赛克/模糊要从底图正确位置采样（V5 修复）。
 * baseImg 缺省时马赛克退化为色块、模糊退化为半透明块。 */
function drawAnnot(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg?: HTMLImageElement | null,
  offX = 0,
  offY = 0,
) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (a.type) {
    case "rect": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      ctx.strokeRect(x, y, Math.abs(a.x2 - a.x), Math.abs(a.y2 - a.y));
      break;
    }
    case "ellipse": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      const w = Math.abs(a.x2 - a.x);
      const h = Math.abs(a.y2 - a.y);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const ang = Math.atan2(a.y2 - a.y, a.x2 - a.x);
      const head = 10 + a.width * 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      // 双箭头：两端各一个箭头头（V6.19）
      const drawHead = (x: number, y: number, dir: number) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - head * Math.cos(ang + dir), y - head * Math.sin(ang + dir));
        ctx.lineTo(x - head * Math.cos(ang - dir), y - head * Math.sin(ang - dir));
        ctx.closePath();
        ctx.fill();
      };
      drawHead(a.x2, a.y2, 0.45);
      if (a.arrowStyle === "double") drawHead(a.x, a.y, 0.45 + Math.PI);
      break;
    }
    case "pen": {
      if (!a.points || a.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(a.points[0][0], a.points[0][1]);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i][0], a.points[i][1]);
      ctx.stroke();
      break;
    }
    case "highlight": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, y, Math.abs(a.x2 - a.x), Math.abs(a.y2 - a.y));
      ctx.globalAlpha = 1;
      break;
    }
    case "mosaic": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      const w = Math.abs(a.x2 - a.x);
      const h = Math.abs(a.y2 - a.y);
      if (baseImg) {
        // 真实像素化：先把区域缩小到色块分辨率，再关平滑放大回原尺寸。
        // 色块 12px（过小看不出打码效果——实测 4px 几乎无感）；V6.19 滚轮可调强度
        const cell = a.strength ?? 12;
        const cw = Math.max(1, Math.round(w / cell));
        const ch = Math.max(1, Math.round(h / cell));
        const tmp = document.createElement("canvas");
        tmp.width = cw;
        tmp.height = ch;
        const tctx = tmp.getContext("2d");
        if (tctx) {
          tctx.imageSmoothingEnabled = true;
          tctx.drawImage(baseImg, offX + x, offY + y, w, h, 0, 0, cw, ch);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tmp, x, y, w, h);
          ctx.imageSmoothingEnabled = true;
        }
      } else {
        const cell = a.strength ?? 12;
        for (let cy = y; cy < y + h; cy += cell) {
          for (let cx = x; cx < x + w; cx += cell) {
            ctx.fillRect(cx, cy, cell, cell);
          }
        }
      }
      break;
    }
    case "blur": {
      const x = Math.min(a.x, a.x2);
      const y = Math.min(a.y, a.y2);
      const w = Math.abs(a.x2 - a.x);
      const h = Math.abs(a.y2 - a.y);
      if (baseImg) {
        // 高斯模糊：先复制区域到不透明临时画布，再在临时画布上模糊后整体画回。
        // ⚠️ 直接在透明画布上 filter:blur + drawImage 会在边缘产生半透明羽化
        // （卷积采样不足→alpha 下降），模糊边缘发虚透出原图——实测坑。
        // V6.19 滚轮可调强度
        const radius = a.strength ?? 10;
        const tmp = document.createElement("canvas");
        tmp.width = Math.max(1, Math.round(w));
        tmp.height = Math.max(1, Math.round(h));
        const tctx = tmp.getContext("2d");
        if (tctx) {
          tctx.drawImage(baseImg, offX + x, offY + y, w, h, 0, 0, tmp.width, tmp.height);
          const out = document.createElement("canvas");
          out.width = tmp.width;
          out.height = tmp.height;
          const octx = out.getContext("2d");
          if (octx) {
            octx.filter = `blur(${radius}px)`;
            octx.drawImage(tmp, 0, 0);
            ctx.drawImage(out, x, y);
          }
        }
      } else {
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }
      break;
    }
    case "text": {
      ctx.font = `${a.size ?? TEXT_SIZE}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.fillText(a.text ?? "", a.x, a.y + (a.size ?? TEXT_SIZE));
      break;
    }
    case "number": {
      const r = (a.size ?? TEXT_SIZE) / 2;
      ctx.beginPath();
      ctx.arc(a.x + r, a.y + r, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `600 ${(a.size ?? TEXT_SIZE) * 0.6}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(a.text ?? "1", a.x + r, a.y + r + 1);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      break;
    }
  }
  ctx.restore();
}

/* ===== 主组件 ===== */
export function ScreenshotOverlay() {
  // ⚠️ 这一行是 AI 出口能不能用的前提。截图窗口是独立 React root（screenshot-main.tsx，
  // 独立 JS 上下文），aiAvailability 那份模块级状态在本上下文里是全新的、初始为 "loading"，
  // 于是 isAiAvailable() 恒返回 false。主窗口的 useAiStatus 调过 ensureAiAvailabilityLoaded 不算数。
  // 不挂这个 hook，「AI 解释」「一键翻译」在截图窗口里点了永远没反应——与用户开没开 AI 无关。
  // （hook 内部已包含 ensureAiAvailabilityLoaded + ensureAiConfigListener + 订阅，不重复造轮子。）
  const aiOk = useAiStatus().status === "on";
  const [screen, setScreen] = useState<ScreenInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("select");
  const [sel, setSel] = useState<Rect | null>(null);
  const [selDraft, setSelDraft] = useState<Rect | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);
  const [tool, setTool] = useState<ToolId>("rect");
  const [color, setColor] = useState(COLORS[1]);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number } | null>(null);
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  // V2：AI / 动作链弹层
  const [aiOpen, setAiOpen] = useState(false);
  const [aiActions, setAiActions] = useState<AiActionMeta[]>([]);
  const [aiBusyId, setAiBusyId] = useState<string | null>(null);
  const [aiRes, setAiRes] = useState<PopRun | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [chains, setChains] = useState<ChainDef[]>([]);
  const [chainBusyId, setChainBusyId] = useState<string | null>(null);
  const [chainRes, setChainRes] = useState<ChainRunResult | null>(null);
  const [chainErr, setChainErr] = useState<string | null>(null);
  const [copiedOut, setCopiedOut] = useState(false);
  // confirm 态继续时复用的 action（aiBusyId 在 finally 已清空）
  const lastAiActionRef = useRef<AiActionMeta | null>(null);
  // V3：吸附窗口 + 长截图（V6.19 hover 即选区后 snap 预览退役，吸附直接写入 sel）
  const [longShot, setLongShot] = useState(false);
  // V4：二维码识别结果
  const [qr, setQr] = useState<string | null>(null);
  const [qrCopied, setQrCopied] = useState(false);
  const resultCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // V4：表格识别
  const [tableOpen, setTableOpen] = useState(false);
  const [tableCsv, setTableCsv] = useState("");
  const [tableErr, setTableErr] = useState<string | null>(null);
  const [tableCopied, setTableCopied] = useState(false);
  // V6.19：OCR 文本编辑（改错字再复制，微信 OCR 面板同款）
  const [ocrEditOpen, setOcrEditOpen] = useState(false);
  const [ocrEditText, setOcrEditText] = useState("");
  const [ocrEditCopied, setOcrEditCopied] = useState(false);
  // A 方案：OCR 提前到标注态 + 抽屉可手动展开（Ctrl+R）+ 完成复制后文字 toast
  const preloadOcrStartedRef = useRef(false);
  const [ocrDrawerOpen, setOcrDrawerOpen] = useState(false);
  const [ocrToast, setOcrToast] = useState<string | null>(null);
  const ocrToastTimerRef = useRef<number | null>(null);
  /** toast 点击时复制的内容（null → 复制 OCR 全文；动作链结果用非空覆盖） */
  const ocrToastCopyRef = useRef<string | null>(null);
  /** V6.19 编辑器目标文件（打开时显示"插入到当前文档"） */
  const [editorTarget, setEditorTarget] = useState<string | null>(null);
  // A 方案增强：OCR 识别过程可见——"识别中…"指示 → 完成胶囊（自动滑入，6s 收起）
  const [ocrStatus, setOcrStatus] = useState<"idle" | "running" | "done" | "empty">("idle");
  const ocrCapsuleTimerRef = useRef<number | null>(null);
  const ocrDrawerOpenRef = useRef(false);
  ocrDrawerOpenRef.current = ocrDrawerOpen;
  // V5：固定区域
  const [regionSaved, setRegionSaved] = useState(false);
  /** 当前是否已存了固定区域——决定 ⋯ 面板那一行是「记住」还是「清除」。
   *  惰性初始化：只在挂载时读一次 localStorage，不在渲染里读。 */
  const [hasFixedRegion, setHasFixedRegion] = useState(() => {
    try {
      return !!localStorage.getItem("pp_shot_region");
    } catch {
      return false;
    }
  });
  // V6 诊断：截屏失败可见化（不再静默关窗，用户能看到原因）
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** 选区是否已确定。true 时 hover 吸附不再改动选区。
   *  置位时机：拖选有效 / 选区内原地单击 / 双击 / 平移结束 / 固定区域恢复；
   *  清位：选区外原地点击（视为误点）、右键回选区态、resetShot。
   *  ⚠️ 原名 draggedRef（“拖过没”）名不副实——它管的一直是“选区是否已确定”，
   *  加了固定区域恢复之后更不符，故改名。 */
  const selFixedRef = useRef(false);
  // B 方案：选区移动（按下选区内拖动 = 平移；原地单击 = 进标注）
  const moveSelRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const snapTsRef = useRef(0);
  // V6.19 磁吸参照：最后一次 hover 命中的窗口（拖选/缩放时边缘对齐用）
  const lastSnapRef = useRef<Rect | null>(null);
  const abortLongRef = useRef(false);
  const longShotRef = useRef(false);
  longShotRef.current = longShot;
  // V4：标注态调整选区（把手）
  const [resizing, setResizing] = useState<string | null>(null);
  const resizeStartRef = useRef<{ sel: Rect; mx: number; my: number } | null>(null);
  // V5：标注元素选中编辑（V6.19 支持 Shift 多选批量移动/删除）
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // V6.19：箭头样式 / 吸管取色
  const [arrowStyle, setArrowStyle] = useState<"single" | "double">("single");
  const [pickerColor, setPickerColor] = useState<string | null>(null);
  const pickerPrevToolRef = useRef<ToolId>("rect");
  // V6.19：马赛克/模糊强度（滚轮调节，绘制时固化到元素）
  const [mosaicStrength, setMosaicStrength] = useState(12);
  const [blurStrength, setBlurStrength] = useState(10);
  const [strengthHint, setStrengthHint] = useState<string | null>(null);
  const strengthHintTimerRef = useRef<number | null>(null);
  const annotMoveRef = useRef<{
    startX: number;
    startY: number;
    orig: { id: number; x: number; y: number; x2: number; y2: number; points?: [number, number][] }[];
  } | null>(null);
  const annotResizeRef = useRef<{
    id: number;
    dir: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origX2: number;
    origY2: number;
    origSize?: number;
  } | null>(null);
  const moveSnapshotRef = useRef<Annotation[] | null>(null);

  const dpr = window.devicePixelRatio || 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<Annotation | null>(null);
  const phaseRef = useRef<Phase>("select");
  phaseRef.current = phase;
  const selRef = useRef<Rect | null>(null);
  selRef.current = sel;
  // commitAnnot 要拿「当前 annotations」压 undo 栈，但不能写成在 setAnnotations 的 updater 里嵌套
  // setUndoStack（见下方注释），所以用 ref 拿最新值。
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  // 快捷键 effect 的依赖数组盖不全 copyImage 用到的状态（busy / ocr / editorTarget…），
  // 直接闭包捕获会拿到旧值——最要命的是 busy 陈旧会让重入保护失效，
  // 连按 Enter 会并发跑两遍「合成 + 复制 + 入库」。用 ref 始终指向最新实现。
  const copyImageRef = useRef<() => void>(() => {});
  // V2：底图 Image（马赛克采样 + 合成 + 放大镜共用），物理像素
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  // 放大镜（直接操作 DOM，避免拖选高频 setState 重渲染）
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magInfoRef = useRef<HTMLSpanElement | null>(null);
  const magVisibleRef = useRef(false);
  const magHexRef = useRef("#000000");

  /* 拖选状态（select 态，物理坐标，相对虚拟屏幕原点） */
  const dragRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);

  /* V6.19：清空 OCR 状态（重选/重截时重置，防旧选区行框错位 + 提前识别不触发） */
  const clearOcrState = useCallback(() => {
    setOcr(null);
    setOcrStatus("idle");
    setOcrDrawerOpen(false);
    setOcrToast(null);
    if (ocrCapsuleTimerRef.current) window.clearTimeout(ocrCapsuleTimerRef.current);
    preloadOcrStartedRef.current = false;
  }, []);

  /* V6：窗口常驻后，每次重新唤出（screenshot-refresh）重置全部状态再截新屏 */
  const resetShot = useCallback(() => {
    setPhase("select");
    setSel(null);
    setSelDraft(null);
    selFixedRef.current = false;
    lastSnapRef.current = null;
    setStrengthHint(null);
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedIds([]);
    setTextDraft(null);
    clearOcrState();
    setQr(null);
    setResultPath(null);
    setAiOpen(false);
    setAiRes(null);
    setChainOpen(false);
    setChainRes(null);
    setTableOpen(false);
    setTableCsv("");
    setTableErr(null);
    setCaptureError(null);
    hideMag();
    // hideMag 是稳定 useCallback（定义在下方），依赖不加它安全（仅调用 setState）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ===== 初始化：贴图双击编辑 → 载图进标注；否则截屏 → 选区 ===== */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenRefresh: (() => void) | null = null;

    const applyScreen = (s: ScreenInfo) => {
      if (disposed) return;
      setScreen(s);
      // V5 固定区域：恢复上次记住的选区（钳制到当前屏幕）
      try {
        const raw = localStorage.getItem("pp_shot_region");
        if (raw) {
          const r = JSON.parse(raw) as { x: number; y: number; w: number; h: number };
          if (r && r.w >= 4 && r.h >= 4) {
            setSel({
              x: Math.max(0, Math.min(r.x, s.width - r.w)),
              y: Math.max(0, Math.min(r.y, s.height - r.h)),
              w: Math.min(r.w, s.width),
              h: Math.min(r.h, s.height),
            });
            // 方案 B：固定区域语义上就是「这块区域我已经确认过了」，直接落到已确认状态
            // （= annotate 态，等价于微信截图确认选区后的样子），省掉一次点击。
            // 不这么做就得把一个已确认的选区塞回未确认态，再想办法不让 hover 覆盖它。
            // 要换区域按 Esc 回 select 态（hover 恢复）。
            selFixedRef.current = true;
            setPhase("annotate");
          }
        }
      } catch {
        /* 本地存储损坏时忽略 */
      }
    };

    // V6 启动提速：优先取后端并行预截屏的缓存（热键回调里已开始截屏），
    // 取不到（窗口创建快于截屏完成）才回退自行截屏
    const capture = () =>
      invoke<ScreenInfo | null>("take_pending_shot_capture")
        .then((s) => {
          if (s) {
            applyScreen(s);
            return;
          }
          return invoke<ScreenInfo>("capture_screen").then(applyScreen);
        })
        .catch((e) => {
          logger.error("截图失败", e);
          // 不静默关窗：显示错误原因，用户可 Esc 关闭或重试
          if (!disposed) setCaptureError(String(e));
        });

    const enterEditMode = async (path: string) => {
      try {
        const dataUrl = await invoke<string>("get_image_data_url", { path });
        const img = await loadImage(dataUrl);
        const [vsw, vsh] = await invoke<[number, number]>("virtual_screen_size");
        // 原图 fit 到虚拟屏幕 90%，窗口 resize 匹配（物理像素）
        const scale = Math.min(1, (vsw * 0.9) / img.naturalWidth, (vsh * 0.9) / img.naturalHeight);
        const dispW = Math.max(1, Math.round(img.naturalWidth * scale));
        const dispH = Math.max(1, Math.round(img.naturalHeight * scale));
        const { getCurrentWindow, PhysicalSize, PhysicalPosition } = await import(
          "@tauri-apps/api/window"
        );
        const win = getCurrentWindow();
        await win.setSize(new PhysicalSize(dispW, dispH));
        await win.setPosition(
          new PhysicalPosition(Math.round((vsw - dispW) / 2), Math.round((vsh - dispH) / 2)),
        );
        // 生成 fit 图作为底图：坐标/合成全按 fit 尺寸，普通合成逻辑直接复用
        const c = document.createElement("canvas");
        c.width = dispW;
        c.height = dispH;
        const cctx = c.getContext("2d");
        if (!cctx) return;
        cctx.drawImage(img, 0, 0, dispW, dispH);
        const fitDataUrl = c.toDataURL("image/jpeg", 0.9);
        if (disposed) return;
        setScreen({ dataUrl: fitDataUrl, originX: 0, originY: 0, width: dispW, height: dispH });
        setSel({ x: 0, y: 0, w: dispW, h: dispH });
        setPhase("annotate");
      } catch (err) {
        logger.error("编辑模式载图失败", err);
        void invoke("close_screenshot_window");
      }
    };

    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen("screenshot-edit-image", (e) => {
        const p = e.payload as string;
        if (p) void enterEditMode(p);
      }).then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
      // ⚠️ 这个 listen 的返回值也必须接住：原实现直接丢弃，cleanup 里只 unlisten 了上面那个，
      // StrictMode 双挂载下会多留一个监听器 → 按一次热键 resetShot + capture 跑两遍（两次全屏截图）。
      void listen("screenshot-refresh", () => {
        resetShot();
        void capture();
      }).then((u) => {
        if (disposed) u();
        else unlistenRefresh = u;
      });
    });
    // 贴图双击进入编辑：优先取 pending，否则走普通截屏
    void invoke<string | null>("take_pending_shot_edit")
      .then((p) => {
        if (disposed) return;
        if (p) void enterEditMode(p);
        else void capture();
      })
      .catch(() => void capture());
    return () => {
      disposed = true;
      unlisten?.();
      unlistenRefresh?.();
    };
  }, [resetShot]);

  /* 底图 Image 预加载（马赛克采样 / 合成 / 放大镜共用） */
  useEffect(() => {
    if (!screen) return;
    void loadImage(screen.dataUrl).then((img) => {
      baseImgRef.current = img;
    });
  }, [screen]);

  /* ===== 画布重绘 ===== */
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const base = baseImgRef.current;
    const r = selRef.current;
    const ox = r ? r.x : 0;
    const oy = r ? r.y : 0;
    for (const a of annotations) drawAnnot(ctx, a, base, ox, oy);
    if (draftRef.current) drawAnnot(ctx, draftRef.current, base, ox, oy);
    // V5：选中元素高亮虚线框（多选逐个画）
    if (selectedIds.length > 0) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#3B9EFF";
      ctx.lineWidth = 1.5;
      for (const id of selectedIds) {
        const a = annotations.find((x) => x.id === id);
        if (!a) continue;
        const x = Math.min(a.x, a.x2) - 5;
        const y = Math.min(a.y, a.y2) - 5;
        const w = Math.abs(a.x2 - a.x) + 10;
        const h = Math.abs(a.y2 - a.y) + 10;
        ctx.strokeRect(x, y, w, h);
      }
      ctx.restore();
    }
  }, [annotations, selectedIds]);

  useEffect(() => {
    redraw();
  }, [redraw, tool, sel]);

  /* V4：标注态拖把手调整选区（window 级监听，可拖出画布） */
  useEffect(() => {
    if (!resizing || !resizeStartRef.current) return;
    const onMove = (e: MouseEvent) => {
      const start = resizeStartRef.current;
      const sc = screen;
      if (!start || !sc) return;
      const dx = (e.clientX - start.mx) * dpr;
      const dy = (e.clientY - start.my) * dpr;
      let { x, y, w, h } = start.sel;
      const right = x + w;
      const bottom = y + h;
      const min = 20;
      if (resizing.includes("e")) w = Math.max(min, right + dx - x);
      if (resizing.includes("w")) {
        x = Math.min(right - min, x + dx);
        w = right - x;
      }
      if (resizing.includes("s")) h = Math.max(min, bottom + dy - y);
      if (resizing.includes("n")) {
        y = Math.min(bottom - min, y + dy);
        h = bottom - y;
      }
      const clamped = {
        x: Math.max(0, Math.min(x, sc.width - min)),
        y: Math.max(0, Math.min(y, sc.height - min)),
        w: Math.min(w, sc.width),
        h: Math.min(h, sc.height),
      };
      // V6.19 磁吸：缩放时边缘对齐 屏幕边/中心线/hover 窗口边缘
      setSel(applyMagnet(clamped, lastSnapRef.current ? [lastSnapRef.current] : [], sc.width, sc.height));
    };
    const onUp = () => {
      setResizing(null);
      resizeStartRef.current = null;
      // 选区变了，旧 OCR 结果的行框坐标就不再对得上（抽屉里高亮框会错位）。
      // clearOcrState 同时会把 preloadOcrStartedRef 置 false，新选区会重新提前识别。
      clearOcrState();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, screen, dpr, clearOcrState]);

  /* ===== 快捷键 ===== */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      // 只拦真正的文本输入控件。原实现把 BUTTON 也拦了，后果是用鼠标点过任何工具按钮后
      // （焦点留在按钮上），数字键切工具、方向键微调、Ctrl+Z 全部失效——
      // 规则 17.1 说键盘是加速器，不该被一次鼠标点击废掉。
      // 它原本要防的「按钮聚焦时 Enter 双触发」改到下面两个 Enter 分支里单独拦。
      const t = e.target as HTMLElement | null;
      const isTextInput =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key !== "Escape" && isTextInput) return;
      const onButton = t?.tagName === "BUTTON";
      if (e.key === "Escape") {
        // 弹层优先于窗口关闭；长截图进行中先中止滚动
        if (aiOpen) {
          setAiOpen(false);
          setAiBusyId(null);
          return;
        }
        if (chainOpen) {
          setChainOpen(false);
          setChainBusyId(null);
          return;
        }
        if (longShotRef.current) {
          abortLongRef.current = true;
          return;
        }
        if (p === "annotate") {
          // 编辑态 Esc = 放弃标注回到选区（Snipaste 两级取消：编辑 → 选区 → 关闭）
          setAnnotations([]);
          setUndoStack([]);
          setRedoStack([]);
          setTextDraft(null);
          setSelectedIds([]);
          clearOcrState();
          setPhase("select");
          return;
        }
        void invoke("close_screenshot_window");
        return;
      }
      if (p === "select" && longShotRef.current) return; // 长截图中忽略其余快捷键
      if (p === "select") {
        // 方向键微调选区（Shift = 10px 快移），已确定选区时生效
        const s = selRef.current;
        if (e.key.startsWith("Arrow") && s) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          const maxX = Math.max(0, (screen?.width ?? 0) - s.w);
          const maxY = Math.max(0, (screen?.height ?? 0) - s.h);
          setSel({
            x: Math.min(maxX, Math.max(0, s.x + dx)),
            y: Math.min(maxY, Math.max(0, s.y + dy)),
            w: s.w,
            h: s.h,
          });
          return;
        }
        // 选区过小（误触点击）时不进入标注；焦点在按钮上时让按钮自己的 click 生效，避免双触发
        if (e.key === "Enter" && !onButton && s && s.w >= 4 && s.h >= 4) setPhase("annotate");
        return;
      }
      if (p === "annotate") {
        // A 方案：Ctrl+R 展开/收起 OCR 抽屉（标注/结果态均可用）
        if ((e.key === "r" || e.key === "R") && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (ocr) setOcrDrawerOpen((v) => !v);
          return;
        }
        // 方向键：有选中元素 → 批量微调元素；否则微调选区（标注跟随选区；Snipaste 同款）
        if (e.key.startsWith("Arrow") && !textDraft) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          if (selectedIds.length > 0) {
            setAnnotations((prev) =>
              prev.map((a) =>
                selectedIds.includes(a.id)
                  ? {
                      ...a,
                      x: a.x + dx,
                      y: a.y + dy,
                      x2: a.x2 + dx,
                      y2: a.y2 + dy,
                      points: a.points ? a.points.map((p) => [p[0] + dx, p[1] + dy]) : a.points,
                    }
                  : a,
              ),
            );
          } else {
            const s = selRef.current;
            const sc = screen;
            if (s && sc) {
              setSel({
                x: Math.max(0, Math.min(s.x + dx, sc.width - s.w)),
                y: Math.max(0, Math.min(s.y + dy, sc.height - s.h)),
                w: s.w,
                h: s.h,
              });
            }
          }
          return;
        }
        // Delete：批量删除选中的标注元素（V5 / V6.19 多选）
        if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0) {
          e.preventDefault();
          moveSnapshotRef.current = annotations;
          setAnnotations((prev) => prev.filter((a) => !selectedIds.includes(a.id)));
          setSelectedIds([]);
          snapshotUndo();
          return;
        }
        if (e.key === "Enter") {
          if (onButton) return; // 焦点在按钮上：让按钮自己的 click 生效，不在这里重复触发
          // 微信同款：Enter = 完成并复制。走 ref：本 effect 的依赖盖不全 copyImage 用到的状态，
          // 直接调闭包里那份会拿到陈旧的 busy/ocr。
          void copyImageRef.current();
          return;
        }
        // Ctrl+Z / Ctrl+Y
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          undo();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
          e.preventDefault();
          redo();
          return;
        }
        if (e.key >= "1" && e.key <= "9") {
          setTool(TOOLS[Number(e.key) - 1].id);
        } else if (e.key === "0") {
          setTool("eraser");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, undoStack, redoStack, aiOpen, chainOpen, selectedIds]);

  /* select 态失焦自动取消（用户点击其他窗口 = 放弃截图，否则遮罩常驻盖屏）。
   * ⚠️ 长截图进行中窗口被主动 hide 也会触发 blur——此时绝不能关闭窗口（V3 bug）。
   * ⚠️ 窗口 show/focus 时序抖动（打开瞬间未稳定聚焦）也可能触发一次 blur——800ms 内忽略。 */
  useEffect(() => {
    const openedAt = Date.now();
    const onBlur = () => {
      if (longShotRef.current) return;
      if (Date.now() - openedAt < 800) return;
      if (phaseRef.current === "select") void invoke("close_screenshot_window");
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  /* ===== 撤销 / 重做（依赖快照版本，避免 setState updater 内嵌套 setState 的严格模式双调用问题） ===== */
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setAnnotations(prev);
    setRedoStack((r) => [...r, annotations]);
    setUndoStack(undoStack.slice(0, -1));
  }, [undoStack, annotations]);
  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setAnnotations(next);
    setUndoStack((u) => [...u, annotations]);
    setRedoStack(redoStack.slice(0, -1));
  }, [redoStack, annotations]);

  /* ===== 提交一个标注元素（入栈） ===== */
  const commitAnnot = useCallback((a: Annotation) => {
    // ⚠️ 不能写成 setAnnotations(prev => { setUndoStack(...); return [...prev, a]; })：
    // StrictMode 下 updater 会被调用两次，嵌套的 setUndoStack 跟着执行两次，
    // 同一份快照被压进 undo 栈两份 → Ctrl+Z 要按两次才退一格。
    // （undo/redo 那两个 useCallback 的注释早就写明要避开这个模式，这里是漏网的一处。）
    const prev = annotationsRef.current;
    setUndoStack((u) => [...u, prev]);
    setRedoStack([]);
    setAnnotations([...prev, a]);
  }, []);

  /* V5：原地更新标注元素（移动/缩放用，不上 undo——由操作结束统一快照） */
  const updateAnnot = useCallback((id: number, patch: Partial<Annotation>) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  /* V5：操作结束统一入 undo（移动/缩放/删除共用：先把操作前的快照压栈） */
  const snapshotUndo = useCallback(() => {
    const snap = moveSnapshotRef.current;
    if (!snap) return;
    moveSnapshotRef.current = null;
    setUndoStack((u) => [...u, snap]);
    setRedoStack([]);
  }, []);

  /* ===== 完成：合成 → 保存 → OCR ===== */
  /** 统一收尾：canvas 合成图 → 保存 → OCR → result 态（普通截图 / 长截图共用） */
  const finalizeCanvas = useCallback(async (out: HTMLCanvasElement) => {
    // V2：JPEG 合成（4K 全屏 PNG 编码要数秒，JPEG 体积/速度均优；底图不透明无损失）
    const dataUrl = out.toDataURL("image/jpeg", 0.92);
    const path = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
    setResultPath(path);
    resultCanvasRef.current = out; // 供二维码识别（result 态 useEffect 取用）
    // OCR：复用现有 PP-OCRv6 引擎（行级坐标相对合成图，与标注画布同坐标系）
    try {
      const ocrResult = await ocrImage(path);
      setOcr(ocrResult);
    } catch (err) {
      logger.warn("OCR 识别失败（不影响图片结果）", err);
      setOcr({ lines: [], fullText: "" });
    }
    setPhase("result");
    setTextDraft(null);
  }, []);

  /* V4：result 态本地二维码/条码识别（jsQR，全程本地不解码不上云） */
  useEffect(() => {
    if (phase !== "result") {
      setQr(null);
      return;
    }
    const src = resultCanvasRef.current;
    if (!src) return;
    let cancelled = false;
    const run = async () => {
      try {
        // jsQR 复杂度 O(wh)：长边缩到 1600 再解码，兼顾小码识别率与性能
        const scale = Math.min(1, 1600 / Math.max(src.width, src.height));
        const w = Math.max(1, Math.round(src.width * scale));
        const h = Math.max(1, Math.round(src.height * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(src, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        // 动态加载 jsqr：不占截图启动路径的 bundle（仅结果态识别时拉取）
        const jsQR = (await import("jsqr")).default;
        const res = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
        if (res && res.data && !cancelled) setQr(res.data);
        // 识别完成：释放 4K 合成 canvas（RGBA 约 33MB），减少常驻内存
        if (!cancelled) resultCanvasRef.current = null;
      } catch (err) {
        logger.warn("二维码识别失败（不影响主流程）", err);
        resultCanvasRef.current = null;
      }
    };
    // 让 result UI 先渲染，解码异步跑不卡界面
    const t = window.setTimeout(run, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [phase]);

  /* 标注或选区一变，已合成的结果图就作废——否则下面 ensureResultPath 的幂等会把旧图直接返回，
   * 后加的标注不会出现在复制/保存出去的图里。
   * 典型踩法：标注 → Enter（生成图 A，因敏感内容/自动链失败而没关窗）→ Esc 回选区
   * → 重选重标注 → Enter，拿到的仍是 A。Esc 分支清了 annotations/undo/ocr，唯独没清 resultPath。
   * 收口在这里而不是逐个出口补 setResultPath(null)，避免第 N 个出口被新写出来时又漏掉（规则 11.1）。 */
  useEffect(() => {
    if (phaseRef.current === "result") return; // result 态已定稿，标注不再可改
    setResultPath(null);
  }, [annotations, sel]);

  /** 合成标注结果并落盘（幂等：已有 resultPath 直接返回）。finish（进面板）与
   *  copyImage（微信同款：完成=直接复制）共用，避免标注态复制时无图可拷。 */
  const ensureResultPath = useCallback(async (): Promise<string> => {
    if (resultPath) return resultPath;
    const s = screen;
    const r = selRef.current;
    if (!s || !r) throw new Error("缺少选区或底图");
    const img = await loadImage(s.dataUrl);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(r.w));
    out.height = Math.max(1, Math.round(r.h));
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("canvas 2d 不可用");
    ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    for (const a of annotations) drawAnnot(ctx, a, img, r.x, r.y);
    const dataUrl = out.toDataURL("image/jpeg", 0.92);
    const path = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
    resultCanvasRef.current = out;
    setResultPath(path);
    return path;
  }, [screen, annotations, resultPath]);

  const finish = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await ensureResultPath();
      // V6.19：编辑器打开时显示"插入到当前文档"出口
      try {
        const t = await invoke<string | null>("get_editor_target");
        setEditorTarget(t);
      } catch {
        /* 查询失败保持隐藏 */
      }
      // OCR（result 面板行级高亮 / 表格识别 / 记忆检索）
      if (!ocr) {
        try {
          const ocrResult = await ocrImage(path);
          setOcr(ocrResult);
        } catch (err) {
          logger.warn("OCR 识别失败（不影响图片结果）", err);
          setOcr({ lines: [], fullText: "" });
        }
      }
      setPhase("result");
      setTextDraft(null);
    } catch (err) {
      logger.error("截图合成失败", err);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureResultPath, ocr]);

  /** V3：长截图（滚动拼接）。隐藏截图窗口 → 循环 截屏+匹配+滚轮 → 恢复窗口出结果 */
  const startLongShot = useCallback(async () => {
    const r = selRef.current;
    if (!r || longShot || busy) return;
    abortLongRef.current = false;
    setLongShot(true);
    try {
      await invoke("hide_screenshot_window");
      const pieces: HTMLCanvasElement[] = [];
      let prevCanvas: HTMLCanvasElement | null = null;
      let totalH = 0;
      const MAX_STEPS = 40;
      const MAX_H = 12000; // 浏览器 canvas 高度上限附近，防爆

      // 选区在屏幕坐标系的位置（循环里不变，算一次就行）
      const [rx, ry] = toScreenPt(screen, r.x, r.y);
      const rw = Math.max(1, Math.round(r.w));
      const rh = Math.max(1, Math.round(r.h));

      /** 抓一张缩小版选区，专用于判断画面是否已渲染稳定（只截选区后这一步很便宜） */
      const probe = async (): Promise<ImageData | null> => {
        try {
          const s = await invoke<ScreenInfo>("capture_region", {
            x: Math.round(rx),
            y: Math.round(ry),
            w: rw,
            h: rh,
          });
          const im = await loadImage(s.dataUrl);
          const pw = STABLE_PROBE_W;
          const ph = Math.max(4, Math.round((rh / rw) * pw));
          const c = document.createElement("canvas");
          c.width = pw;
          c.height = ph;
          const cx = c.getContext("2d", { willReadFrequently: true });
          if (!cx) return null;
          cx.drawImage(im, 0, 0, pw, ph);
          return cx.getImageData(0, 0, pw, ph);
        } catch {
          return null;
        }
      };

      /** 滚动后等到画面稳定（连续两次采样一致），最多 STABLE_MAX_MS。
       *  等不到稳定点就按上限返回——宁可多等也不能截到半渲染的画面。 */
      const waitStable = async () => {
        let prevProbe: ImageData | null = null;
        for (let t = 0; t < STABLE_MAX_MS; t += STABLE_STEP_MS) {
          await sleep(STABLE_STEP_MS);
          const cur = await probe();
          if (!cur) return; // 采样失败：不阻塞主流程
          if (prevProbe && framesAlike(prevProbe, cur)) return;
          prevProbe = cur;
        }
      };

      // 部分应用不响应 PostMessage 滚轮，发现画面没动时切到 SendInput 重试一次
      let wheelForceInput = false;

      /** 向选区中心注入一次向下滚轮（坐标要屏幕坐标系） */
      const scrollOnce = async () => {
        const [wx, wy] = toScreenPt(screen, r.x + r.w / 2, r.y + r.h / 2);
        await invoke("send_mouse_wheel", {
          x: Math.round(wx),
          y: Math.round(wy),
          delta: -120,
          forceInput: wheelForceInput,
        });
      };

      for (let i = 0; i < MAX_STEPS && !abortLongRef.current; i++) {
        // 只截选区，不再截全屏再裁。原实现每帧跑一遍
        // 「全屏 BitBlt → BGRA→RGBA → RGB8 → JPEG 编码 → base64 → IPC → Image 解码 → drawImage 裁出选区」，
        // 最后一步才把大部分像素丢掉——选区占屏 1/5 就有 80% 是白做的，而这要跑最多 40 遍。
        const shot = await invoke<ScreenInfo>("capture_region", {
          x: Math.round(rx),
          y: Math.round(ry),
          w: rw,
          h: rh,
        });
        const img = await loadImage(shot.dataUrl);
        const piece = document.createElement("canvas");
        piece.width = Math.max(1, Math.round(r.w));
        piece.height = Math.max(1, Math.round(r.h));
        const pctx = piece.getContext("2d");
        if (!pctx) break;
        // 返回的已经就是选区尺寸，直接画，不再需要源矩形参数
        pctx.drawImage(img, 0, 0);

        let append: HTMLCanvasElement;
        let visible = piece.height;
        if (prevCanvas) {
          const overlap = findOverlapRows(prevCanvas, piece, piece.width, piece.height);
          if (overlap <= 2) {
            // 画面没动。两种可能：真的滚到底了，或者目标窗口不认 PostMessage 滚轮。
            // 还没试过 SendInput 就先切过去重滚一次，别把「注入方式不被接受」误判成「已到底」。
            if (!wheelForceInput) {
              wheelForceInput = true;
              logger.info("[长截图] PostMessage 滚轮似乎无效，回退 SendInput 重试");
              await scrollOnce();
              await waitStable();
              continue; // 本帧不计入，重新截一帧再判
            }
            break; // 已经用过 SendInput 还不动 → 真到底了
          }
          visible = piece.height - overlap;
          if (visible <= 0) break;
          append = document.createElement("canvas");
          append.width = piece.width;
          append.height = visible;
          append
            .getContext("2d")!
            .drawImage(piece, 0, overlap, piece.width, visible, 0, 0, piece.width, visible);
        } else {
          append = piece;
        }
        if (totalH + visible > MAX_H) break;
        pieces.push(append);
        totalH += visible;
        prevCanvas = piece;

        // 滚动注入（区域中心），然后等画面稳定。
        // 原来是硬等 sleep(280)：40 帧就是 11.2 秒纯等待，快页面也得陪着等。
        await scrollOnce();
        await waitStable();
      }
      // Esc 中止，或一帧都没成功 → 不出图。
      // 原实现 abortLongRef 只跟出循环，后面照样拼接 + finalizeCanvas + 进 result 态，
      // 用户按 Esc 想取消，却得到一张半截图（违反规则 17.6 两级取消）；
      // pieces 为空时 totalH=0，还会存一张 1px 高的垃圾图。
      if (abortLongRef.current || pieces.length === 0) {
        logger.warn(
          `长截图未出图（${abortLongRef.current ? "用户中止" : "未捕获到内容"}），保持当前状态`,
        );
        return; // finally 里会恢复窗口并清 longShot
      }
      // 拼接长图
      const long = document.createElement("canvas");
      long.width = Math.max(1, Math.round(r.w));
      long.height = Math.max(1, totalH);
      const lctx = long.getContext("2d");
      if (lctx) {
        let yy = 0;
        for (const p of pieces) {
          lctx.drawImage(p, 0, yy);
          yy += p.height;
        }
        await finalizeCanvas(long);
      }
    } catch (err) {
      logger.error("长截图失败", err);
    } finally {
      await invoke("show_screenshot_window").catch(() => undefined);
      setLongShot(false);
    }
    // screen 入依赖：滚轮注入要把选区中心换成屏幕坐标，依赖 screen.originX/Y
  }, [longShot, busy, finalizeCanvas, screen]);

  /* ===== 动作出口 ===== */
  // 关闭窗口（按需创建：不常驻占内存，启动提速靠后端并行预截屏）
  const close = () => void invoke("close_screenshot_window");

  /** V6.19：插入到当前编辑文档（图片保存 → 追加引用 → 编辑器 useFileWatch 自动重载） */
  const insertToEditor = async () => {
    if (!editorTarget) return;
    try {
      const path = await ensureResultPath();
      await invoke("insert_into_editor", { editorPath: editorTarget, imagePath: path });
      showOcrToast(`已插入文档 ${editorTarget.split(/[\\/]/).pop()} · 编辑器已刷新`);
      close();
    } catch (e) {
      logger.warn("插入编辑器失败", e);
    }
  };

  /** 完成后的结果 toast（可点击复制，6s 自动消失；copyContent 覆盖复制内容） */
  const showOcrToast = (text: string, copyContent?: string) => {
    ocrToastCopyRef.current = copyContent ?? null;
    setOcrToast(text);
    if (ocrToastTimerRef.current) window.clearTimeout(ocrToastTimerRef.current);
    ocrToastTimerRef.current = window.setTimeout(() => setOcrToast(null), 6000);
  };

  const copyImage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 标注态直接完成：先合成落盘，再复制（微信同款：完成=复制）
      const path = await ensureResultPath();
      await invoke("copy_image_only", { imagePath: path });
      // 配置预查（同步区 await）：决定关窗时机——自动链是前端变换，窗口销毁即中断，
      // 配置了链必须等它跑完再关窗
      let autoChainId: string | null = null;
      try {
        autoChainId = await invoke<string | null>("get_auto_chain_after_screenshot");
      } catch {
        /* 查询失败按无链处理 */
      }
      if (autoChainId) {
        // 有自动链：等 OCR + 链完成再关窗（toast 展示结果后自动关）
        try {
          let text = ocr?.fullText?.trim() || null;
          if (!text) {
            const r = await ocrImage(path);
            text = r.fullText?.trim() || null;
          }
          void invoke("insert_screenshot_to_history", { imagePath: path, ocrText: text }).catch(
            (e) => logger.warn("截图入库失败（不影响复制）", e),
          );
          if (text && !detectSensitiveText(text)) {
            try {
              const chains = await chainList();
              const chain = chains.find((c) => c.id === autoChainId);
              if (chain) {
                const c: Chain = {
                  id: chain.id,
                  name: chain.name,
                  description: chain.description,
                  steps: chain.steps,
                  corrupted: chain.stepsCorrupted,
                  rawSteps: chain.stepsRaw,
                };
                const res = await runChain(c, text, {}, async () => false);
                // 云端步骤中止时 res.final=中止前输入（原文），必须看 res.ok 判成功
                if (res.ok && res.final) {
                  showOcrToast(`⚡ 动作链「${chain.name}」完成 · 点击复制结果`, res.final);
                } else {
                  showOcrToast(`动作链「${chain.name}」已中止 · 含云端步骤未确认`, "");
                }
              }
            } catch (e) {
              logger.warn("截图自动动作链失败", e);
            }
          } else if (text) {
            // 敏感内容 → 跳过自动链（红线），但要提示用户配置的链没跑（防静默）
            showOcrToast(`识别到敏感内容，已跳过自动动作链 · 点击复制文字`);
          }
        } catch (e) {
          logger.warn("复制后 OCR 失败", e);
        }
        close();
      } else {
        // 无自动链：立即关窗，后台异步补 OCR + 主动入库
        void (async () => {
          try {
            let text = ocr?.fullText?.trim() || null;
            let lineCount = ocr?.lines.length ?? 0;
            if (!text) {
              const r = await ocrImage(path);
              text = r.fullText?.trim() || null;
              lineCount = r.lines.length;
            }
            void invoke("insert_screenshot_to_history", { imagePath: path, ocrText: text }).catch(
              (e) => logger.warn("截图入库失败（不影响复制）", e),
            );
            // 截图窗口即将关闭，toast 走主窗口（emit_ocr_ready → 主窗口提示文字已就绪）
            if (text) {
              void invoke("emit_ocr_ready", { text, lineCount }).catch(() => {});
            }
          } catch (e) {
            logger.warn("复制后 OCR 失败", e);
          }
        })();
        close();
      }
    } catch (e) {
      logger.error("复制图片失败", e);
    } finally {
      setBusy(false);
    }
  };
  // 每次渲染把最新一份 copyImage 写进 ref，供快捷键 effect 调用（见 copyImageRef 声明处注释）。
  copyImageRef.current = copyImage;

  const saveToGallery = async () => {
    if (!resultPath) return;
    try {
      const dest = await save({
        defaultPath: `PastePanda-截图-${Date.now()}.png`,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] }],
      });
      if (!dest) return; // 用户取消
      await invoke("save_image_file", { source: resultPath, dest });
      close();
    } catch (e) {
      logger.error("保存图片失败", e);
    }
  };

  const copyText = async (text: string) => {
    try {
      await invoke("copy_only", { text });
    } catch (e) {
      logger.error("复制文字失败", e);
    }
  };

  const copyAllText = async () => {
    if (!ocr?.fullText) return;
    await copyText(ocr.fullText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1200);
  };

  const copyRow = async (idx: number) => {
    const line = ocr?.lines[idx];
    if (!line) return;
    await copyText(line.text);
    setCopiedRow(idx);
    setTimeout(() => setCopiedRow(null), 1200);
  };

  const pinImage = () => {
    if (!resultPath) return;
    void invoke("open_pinned_image", { path: resultPath });
    close();
  };

  const reselect = () => {
    setPhase("select");
    setSel(null);
    setSelDraft(null);
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    clearOcrState();
    setResultPath(null);
    numSeqRef.current = 1;
  };

  /* 序号自增 */
  const numSeqRef = useRef(1);

  /* ===== V2：AI 处理 / 送动作链出口 ===== */
  const ocrText = () => ocr?.fullText?.trim() || "";

  const openAi = async () => {
    // 红线（claude.md 规则 16）：AI 总开关未开时，AI 出口一律不打开
    if (!isAiAvailable()) return;
    // 红线兜底：识别文本含疑似密钥/密码时，先确认才允许发云端
    const sensitive = ocrText() ? detectSensitiveText(ocrText()) : null;
    if (sensitive) {
      const ok = window.confirm(
        `检测到疑似敏感内容：${sensitive}\n\n发送到 AI 云端可能造成泄露（PastePanda 默认阻止）。确认安全的话可以继续，否则取消。`,
      );
      if (!ok) return;
    }
    setChainOpen(false);
    setAiRes(null);
    setAiOpen(true);
    if (aiActions.length === 0) {
      try {
        setAiActions(await aiListActions());
      } catch (e) {
        setAiRes({ status: "error", message: String(e) });
      }
    }
  };

  const closeAi = () => {
    setAiOpen(false);
    setAiBusyId(null);
  };

  const runAiAction = async (action: AiActionMeta, force = false) => {
    const text = ocrText();
    if (!text) {
      setAiRes({
        status: "error",
        message: "没有可处理的文字：先点击「识别文字」获得 OCR 结果再试",
      });
      return;
    }
    lastAiActionRef.current = action;
    setAiBusyId(action.id);
    setAiRes({ status: "running", message: `正在调用「${action.label}」…` });
    try {
      const res: AiRunResponse = await aiRun(action.id, text, {}, force);
      if (res.status === "ok") {
        setAiRes({
          status: "ok",
          content: res.content,
          meta: [res.model, res.cached ? "缓存命中" : "", res.truncated ? "已截断" : ""]
            .filter(Boolean)
            .join(" · "),
        });
      } else if (res.status === "needsConfirm") {
        setAiRes({ status: "confirm", confirmReason: res.reason });
      } else {
        setAiRes({
          status: "error",
          message: `已超出预算（本次 ${res.spentCny} 元 / 上限 ${res.budgetCny} 元）`,
        });
      }
    } catch (e) {
      setAiRes({ status: "error", message: String(e) });
    } finally {
      setAiBusyId(null);
    }
  };

  const openChains = async () => {
    // 红线兜底：与 AI 出口对称，识别文本含疑似密钥/密码时先确认（链可能有云端步骤）
    const sensitive = ocrText() ? detectSensitiveText(ocrText()) : null;
    if (sensitive) {
      const ok = window.confirm(
        `检测到疑似敏感内容：${sensitive}\n\n动作链可能包含发送到云端的步骤（PastePanda 默认阻止）。确认安全的话可以继续，否则取消。`,
      );
      if (!ok) return;
    }
    setAiOpen(false);
    setChainErr(null);
    setChainRes(null);
    setChainOpen(true);
    if (chains.length === 0) {
      try {
        setChains(await chainList());
      } catch (e) {
        setChainErr(String(e));
      }
    }
  };

  const closeChains = () => {
    setChainOpen(false);
    setChainBusyId(null);
  };

  const runChainAction = async (chain: ChainDef) => {
    const text = ocrText();
    if (!text) {
      setChainErr("没有可处理的文字：先点击「识别文字」获得 OCR 结果再试");
      return;
    }
    // 二道防线（规则 16）：弹层里已经把含云端步骤的链置灰了，但不能只靠视觉拦——
    // 键盘/脚本/以后新写的入口都可能绕过 UI 直接调到这里。
    if (!aiOk && chainNeedsAi(chain)) {
      setChainErr("这条链包含云端步骤，需要先在设置里开启 AI");
      return;
    }
    setChainBusyId(chain.id);
    setChainErr(null);
    try {
      const c: Chain = { id: chain.id, name: chain.name, description: chain.description, steps: chain.steps, corrupted: chain.stepsCorrupted, rawSteps: chain.stepsRaw };
      const res = await runChain(c, text, {}, async (step) => {
        return window.confirm(
          `「${step.label}」这一步会把内容发送到云端（可能计费），是否继续？`,
        );
      });
      setChainRes(res);
    } catch (e) {
      setChainErr(String(e));
    } finally {
      setChainBusyId(null);
    }
  };

  const copyChainFinal = async () => {
    if (!chainRes?.final) return;
    await copyText(chainRes.final);
    setCopiedOut(true);
    setTimeout(() => setCopiedOut(false), 1200);
  };

  const copyAiResult = async () => {
    if (!aiRes?.content) return;
    await copyText(aiRes.content);
    setCopiedOut(true);
    setTimeout(() => setCopiedOut(false), 1200);
  };

  /* V4：表格识别（OCR 行坐标几何聚类 → CSV） */
  const openTable = () => {
    if (!ocr) return;
    const table = ocrToTable(ocr.lines);
    if (!table) {
      setTableErr("未能识别出表格结构（文字行太少或只有单列）。可改用「AI 处理」让模型提取。");
      setTableCsv("");
      setTableOpen(true);
      return;
    }
    setTableCsv(table.map((r) => r.map(csvEscape).join(",")).join("\n"));
    setTableErr(null);
    setTableOpen(true);
  };

  const copyTableCsv = async () => {
    if (!tableCsv) return;
    await copyText(tableCsv);
    setTableCopied(true);
    setTimeout(() => setTableCopied(false), 1200);
  };

  /* V6.19 OCR 文本编辑：打开编辑弹层（预填识别全文，可改错字） */
  const openOcrEdit = () => {
    if (!ocr) return;
    setOcrEditText(ocr.fullText);
    setOcrEditOpen(true);
    setOcrEditCopied(false);
  };

  const copyOcrEdited = async () => {
    if (!ocrEditText) return;
    await copyText(ocrEditText);
    setOcrEditCopied(true);
    setTimeout(() => setOcrEditCopied(false), 1200);
  };

  /* V5：记住当前选区为固定区域（下次打开自动恢复） */
  const saveRegion = () => {
    if (!sel) return;
    try {
      localStorage.setItem("pp_shot_region", JSON.stringify(sel));
      setRegionSaved(true);
      setHasFixedRegion(true);
      setTimeout(() => setRegionSaved(false), 1500);
    } catch {
      /* 存储不可用时静默 */
    }
  };

  /** 清除固定区域（⋯ 面板：已有固定区域时同一行变成它）。
   *  没这个出口的话，用户只能靠右键/Esc 回选区态临时绕开，下次截图又会回到固定区域。 */
  const clearRegion = () => {
    try {
      localStorage.removeItem("pp_shot_region");
      setHasFixedRegion(false);
      setRegionSaved(false);
      showOcrToast("已清除固定区域 · 下次截图恢复自动吸附");
    } catch {
      /* 存储不可用时静默 */
    }
  };

  /* V5：一键翻译（截图翻译入口，复用 AI 弹层展示） */
  const translateShot = async () => {
    // 红线（claude.md 规则 16）：AI 总开关未开时，翻译（走 AI 云端）不可用
    if (!isAiAvailable()) return;
    const text = ocrText();
    if (!text) {
      setChainOpen(false);
      setAiOpen(true);
      setAiRes({
        status: "error",
        message: "没有可处理的文字：先点击「识别文字」获得 OCR 结果再试",
      });
      return;
    }
    // 红线兜底：与 AI 出口一致
    const sensitive = detectSensitiveText(text);
    if (sensitive) {
      const ok = window.confirm(
        `检测到疑似敏感内容：${sensitive}\n\n发送到 AI 云端可能造成泄露（PastePanda 默认阻止）。确认安全可以继续，否则取消。`,
      );
      if (!ok) return;
    }
    const fakeAction: AiActionMeta = {
      id: "ai-translate",
      label: "翻译",
      description: "翻译成中文",
      icon: "languages",
      maxTokens: 2000,
      options: [],
      contentTypes: [],
    };
    lastAiActionRef.current = fakeAction;
    setChainOpen(false);
    setAiOpen(true);
    await runAiAction(fakeAction, false);
  };

  /* ===== 放大镜 + 取色（select 态拖选时跟随光标） ===== */
  const updateMag = useCallback((px: number, py: number) => {
    const base = baseImgRef.current;
    const magEl = magRef.current;
    const magCv = magCanvasRef.current;
    if (!base || !magEl || !magCv) return;
    const ctx = magCv.getContext("2d");
    if (!ctx) return;
    const sx = Math.max(0, Math.min(base.naturalWidth - MAG_R * 2, px - MAG_R));
    const sy = Math.max(0, Math.min(base.naturalHeight - MAG_R * 2, py - MAG_R));
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, magCv.width, magCv.height);
    ctx.drawImage(base, sx, sy, MAG_R * 2, MAG_R * 2, 0, 0, MAG_SIZE, MAG_SIZE);
    // 十字准星
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MAG_SIZE / 2, 0);
    ctx.lineTo(MAG_SIZE / 2, MAG_SIZE);
    ctx.moveTo(0, MAG_SIZE / 2);
    ctx.lineTo(MAG_SIZE, MAG_SIZE / 2);
    ctx.stroke();
    // 中心像素颜色（底图精确采样）；探针 canvas 复用，避免拖选高频 createElement 的 GC 压力
    if (!probeCanvas) probeCanvas = document.createElement("canvas");
    const pctx = probeCanvas.getContext("2d");
    if (pctx) {
      pctx.drawImage(base, Math.floor(px), Math.floor(py), 1, 1, 0, 0, 1, 1);
      const d = pctx.getImageData(0, 0, 1, 1).data;
      const hex =
        "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      magHexRef.current = hex;
      if (magInfoRef.current) {
        magInfoRef.current.innerHTML =
          `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;` +
          `background:${hex};vertical-align:-1px;margin-right:5px"></span>` +
          `RGB(${d[0]}, ${d[1]}, ${d[2]}) · <span class="hex">${hex}</span> · 点击复制`;
      }
    }
    // 定位（光标右上，越界翻转）
    const cssSize = MAG_SIZE / dpr;
    let left = px / dpr + 18;
    let top = py / dpr - cssSize - 10;
    if (left + cssSize + 10 > window.innerWidth) left = px / dpr - cssSize - 18;
    if (top < 10) top = py / dpr + 18;
    magEl.style.left = `${left}px`;
    magEl.style.top = `${top}px`;
    magEl.style.display = "flex";
    magVisibleRef.current = true;
  }, [dpr]);

  const hideMag = useCallback(() => {
    magVisibleRef.current = false;
    if (magRef.current) magRef.current.style.display = "none";
  }, []);

  const copyHex = useCallback(async () => {
    try {
      await invoke("copy_only", { text: magHexRef.current });
      if (magInfoRef.current) {
        magInfoRef.current.innerHTML = `<span class="hex">已复制 ${magHexRef.current}</span>`;
      }
    } catch (e) {
      logger.error("复制颜色失败", e);
    }
  }, []);

  /* ===== select 态：微信同款交互（hover 即选区 / 拖选 / 选区移动） ===== */
  const onSelectMouseDown = (e: React.MouseEvent) => {
    if (phase !== "select") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
    // 按在选区内 → 平移选区 / 原地单击进标注（V6.19 单击即标注，微信同款）
    const cur = selRef.current;
    if (cur && px >= cur.x && px <= cur.x + cur.w && py >= cur.y && py <= cur.y + cur.h) {
      moveSelRef.current = { startX: px, startY: py, origX: cur.x, origY: cur.y, moved: false };
      return;
    }
    // 选区外 → 新拖选
    dragRef.current = { startX: px, startY: py, curX: px, curY: py };
    setSelDraft({ x: px, y: py, w: 0, h: 0 });
  };
  const onSelectMouseMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
    // 平移选区
    const m = moveSelRef.current;
    if (m) {
      if (Math.abs(px - m.startX) + Math.abs(py - m.startY) > 4) m.moved = true;
      if (!m.moved) return; // 尚未移动（原地按住）：不动作，等松手判定单击进标注
      const cur = selRef.current;
      const sc = screen;
      if (cur && sc) {
        const dx = px - m.startX;
        const dy = py - m.startY;
        const raw = {
          x: Math.max(0, Math.min(m.origX + dx, sc.width - cur.w)),
          y: Math.max(0, Math.min(m.origY + dy, sc.height - cur.h)),
          w: cur.w,
          h: cur.h,
        };
        // V6.19 磁吸：平移时边缘对齐（Snipaste 同款）
        setSel(applyMagnet(raw, lastSnapRef.current ? [lastSnapRef.current] : [], sc.width, sc.height));
      }
      return;
    }
    // 拖选
    const d = dragRef.current;
    if (d) {
      d.curX = px;
      d.curY = py;
      // V6.19 磁吸：选区边缘对齐 屏幕边/中心线/hover 窗口边缘
      const sc = screen;
      const raw = {
        x: Math.min(d.startX, px),
        y: Math.min(d.startY, py),
        w: Math.abs(px - d.startX),
        h: Math.abs(py - d.startY),
      };
      const draft = sc
        ? applyMagnet(raw, lastSnapRef.current ? [lastSnapRef.current] : [], sc.width, sc.height)
        : raw;
      setSelDraft(draft);
      updateMag(px, py);
      return;
    }
    // hover 即选区（微信同款：移动鼠标选区跟随窗口；拖选有效后固定；手柄调整中不吸附）
    if (selFixedRef.current || resizing) return;
    const now = Date.now();
    if (now - snapTsRef.current >= 90) {
      snapTsRef.current = now;
      // px/py 是底图局部坐标，后端要的是屏幕坐标；返回的矩形反过来要换回局部。
      const [sx, sy] = toScreenPt(screen, px, py);
      void invoke<SnapRect | null>("snap_window_at", {
        x: Math.round(sx),
        y: Math.round(sy),
      })
        .then((s) => {
          if (dragRef.current || moveSelRef.current) return; // 已进入拖选/平移
          if (phaseRef.current !== "select") return;
          if (s && s.w >= 4 && s.h >= 4) {
            const local = toLocalRect(screen, s);
            lastSnapRef.current = local;
            setSel(local);
          } else {
            setSel(null); // 桌面空白 → 无选区（微信同款全暗）
          }
        })
        .catch(() => {
          /* 吸附失败忽略 */
        });
    }
  };
  const onSelectMouseUp = () => {
    // 选区平移结束 / 原地单击 = 进标注（V6.19 单击即标注）
    if (moveSelRef.current) {
      const m = moveSelRef.current;
      moveSelRef.current = null;
      if (!m.moved && phaseRef.current === "select") {
        selFixedRef.current = true;
        setPhase("annotate");
      } else if (m.moved) {
        // 平移结束也算「选区已确定」。不置位的话，hover 吸附会在 90ms 后把刚挪好的选区冲掉
        // （原实现这个分支既不置位也不进标注，直接 return，于是平移功能实际上是废的）。
        selFixedRef.current = true;
      }
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    const w = Math.abs(d.curX - d.startX);
    const h = Math.abs(d.curY - d.startY);
    if (w >= 4 && h >= 4) {
      // 拖选有效 → 固定（移动不再吸附，微信同款）并自动进入标注
      selFixedRef.current = true;
      setSel({ x: Math.min(d.startX, d.curX), y: Math.min(d.startY, d.curY), w, h });
      setPhase("annotate");
    } else {
      // 原地点击 → 回到 hover 吸附模式
      selFixedRef.current = false;
    }
    setSelDraft(null);
    hideMag();
  };

  /* 双击：有选区 → 进入标注；无选区 → 全选并进标注（Snipaste 双击全屏即编辑） */
  const onSelectDoubleClick = () => {
    if (!screen) return;
    selFixedRef.current = true;
    if (selRef.current) {
      setPhase("annotate");
      return;
    }
    setSel({ x: 0, y: 0, w: screen.width, h: screen.height });
    setPhase("annotate");
  };

  /* V5：选中元素把手缩放（window 级监听）
   * 注意：监听必须在 mousedown 时注册（而非挂在依赖 [dpr] 的 effect 上）——挂载时
   * annotResizeRef 为 null 会让 effect 提前 return 且永不重跑，导致 8 个把手完全失效（P0）。 */
  const beginAnnotResize = () => {
    const MIN = 8;
    const onMove = (e: MouseEvent) => {
      const c = annotResizeRef.current;
      if (!c) return;
      const dx = (e.clientX - c.startX) * dpr;
      const dy = (e.clientY - c.startY) * dpr;
      let nx = c.origX;
      let ny = c.origY;
      let nx2 = c.origX2;
      let ny2 = c.origY2;
      if (c.dir.includes("w")) nx = Math.min(c.origX2 - MIN, c.origX + dx);
      if (c.dir.includes("e")) nx2 = Math.max(c.origX + MIN, c.origX2 + dx);
      if (c.dir.includes("n")) ny = Math.min(c.origY2 - MIN, c.origY + dy);
      if (c.dir.includes("s")) ny2 = Math.max(c.origY + MIN, c.origY2 + dy);
      const patch: Partial<Annotation> = { x: nx, y: ny, x2: nx2, y2: ny2 };
      // 文本元素：缩放调整字号（bbox 缩放对文字无意义）
      if (c.origSize) {
        const w = Math.max(1, c.origX2 - c.origX);
        const scale = Math.max(6, Math.min(48, c.origSize * ((nx2 - nx) / w)));
        patch.size = Math.round(scale);
      }
      updateAnnot(c.id, patch);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      annotResizeRef.current = null;
      snapshotUndo();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /* V4：标注态调整选区把手（无选中元素时显示） */
  const onSelHandleDown = (dir: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sel) return;
    resizeStartRef.current = { sel, mx: e.clientX, my: e.clientY };
    setResizing(dir);
  };

  /* V5：选中元素把手按下（仅单选时可用；多选只移动/删除） */
  const onAnnotHandleDown = (dir: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedIds.length !== 1) return;
    const a = annotations.find((x) => x.id === selectedIds[0]);
    if (!a) return;
    moveSnapshotRef.current = annotations;
    annotResizeRef.current = {
      id: selectedIds[0],
      dir,
      startX: e.clientX,
      startY: e.clientY,
      origX: a.x,
      origY: a.y,
      origX2: a.x2,
      origY2: a.y2,
      origSize: a.size,
    };
    beginAnnotResize();
  };

  /* ===== annotate 态：标注交互（annotCanvas，物理坐标 = offset × dpr） ===== */
  /* V6.19 吸管：从底图采样光标处颜色（选区本地坐标 → 全屏偏移） */
  const samplePixel = (px: number, py: number): string | null => {
    const base = baseImgRef.current;
    if (!base) return null;
    if (!probeCanvas) probeCanvas = document.createElement("canvas");
    const pctx = probeCanvas.getContext("2d");
    if (!pctx) return null;
    const r = selRef.current;
    const ox = r ? r.x : 0;
    const oy = r ? r.y : 0;
    pctx.clearRect(0, 0, 1, 1);
    pctx.drawImage(base, ox + px, oy + py, 1, 1, 0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return null;
    const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    return hex;
  };

  const onAnnotMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget;
    const rect = cv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    if (tool === "picker") {
      // 吸管：点击复制色值并恢复上一个工具（Snipaste F1 心智）
      const c = samplePixel(px, py);
      if (c) void copyText(c);
      setTool(pickerPrevToolRef.current);
      setPickerColor(null);
      return;
    }
    if (tool === "text") {
      setTextDraft({ x: px, y: py });
      return;
    }
    if (tool === "eraser") {
      // 橡皮擦：擦除预览路径（灰色）
      setSelectedIds([]);
      draftRef.current = {
        id: nextId(), type: "pen", color: "rgba(239,68,68,0.6)", width: 8,
        x: px, y: py, x2: px, y2: py, points: [[px, py]],
      };
      return;
    }
    // 非绘制工具：先做命中检测 → 选中已有元素（V5；Shift 多选，V6.19）
    if (tool !== "number") {
      const hit = [...annotations].reverse().find((a) => pointHitAnnot(px, py, a));
      if (hit) {
        const multi = e.shiftKey;
        let ids: number[];
        if (multi) {
          ids = selectedIds.includes(hit.id)
            ? selectedIds.filter((x) => x !== hit.id)
            : [...selectedIds, hit.id];
        } else {
          ids = [hit.id];
        }
        setSelectedIds(ids);
        moveSnapshotRef.current = annotations;
        annotMoveRef.current = {
          startX: px,
          startY: py,
          orig: ids
            .map((id) => annotations.find((x) => x.id === id))
            .filter((a): a is Annotation => !!a)
            .map((a) => ({
              id: a.id,
              x: a.x,
              y: a.y,
              x2: a.x2,
              y2: a.y2,
              points: a.points ? a.points.map((p) => [p[0], p[1]]) : undefined,
            })),
        };
        return;
      }
      setSelectedIds([]);
    }
    const a: Annotation = {
      id: nextId(),
      type: tool,
      color: tool === "highlight" || tool === "mosaic" ? color : color,
      width: LINE_WIDTH,
      x: px,
      y: py,
      x2: px,
      y2: py,
      points: tool === "pen" ? [[px, py]] : undefined,
      text: tool === "number" ? String(numSeqRef.current) : undefined,
      size: tool === "number" ? TEXT_SIZE : undefined,
      arrowStyle: tool === "arrow" ? arrowStyle : undefined,
      strength: tool === "mosaic" ? mosaicStrength : tool === "blur" ? blurStrength : undefined,
    };
    if (tool === "number") {
      numSeqRef.current += 1;
      commitAnnot(a);
      return;
    }
    draftRef.current = a;
  };
  const onAnnotMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    // 吸管：实时显示光标处色值
    if (tool === "picker") {
      const c = samplePixel(px, py);
      setPickerColor(c);
      return;
    }
    // 移动已选中元素（V5；多选批量平移）
    const m = annotMoveRef.current;
    if (m) {
      const dx = px - m.startX;
      const dy = py - m.startY;
      setAnnotations((prev) =>
        prev.map((a) => {
          const o = m.orig.find((x) => x.id === a.id);
          if (!o) return a;
          return {
            ...a,
            x: o.x + dx,
            y: o.y + dy,
            x2: o.x2 + dx,
            y2: o.y2 + dy,
            points: o.points ? o.points.map((p) => [p[0] + dx, p[1] + dy]) : a.points,
          };
        }),
      );
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    if (d.type === "pen") {
      d.points = [...(d.points ?? []), [px, py]];
    } else {
      d.x2 = px;
      d.y2 = py;
    }
    redraw();
  };
  /* 标注画布双击：命中元素不处理（选中编辑）；空白双击 = 完成并复制（微信同款） */
  const onAnnotDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const hit = [...annotations].reverse().find((a) => pointHitAnnot(px, py, a));
    if (!hit) void copyImage();
  };

  const onAnnotMouseUp = () => {
    // 元素移动结束：入 undo
    if (annotMoveRef.current) {
      annotMoveRef.current = null;
      snapshotUndo();
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    draftRef.current = null;
    // 橡皮擦：擦除路径命中的元素（V5）
    if (tool === "eraser" && d.points && d.points.length > 1) {
      const toDelete = eraseHits(d.points, annotations);
      if (toDelete.length > 0) {
        moveSnapshotRef.current = annotations;
        setAnnotations((prev) => prev.filter((a) => !toDelete.includes(a.id)));
        snapshotUndo();
      }
      return;
    }
    // 过滤零尺寸误点（矩形/椭圆/箭头/高亮/马赛克/模糊）
    if (d.type !== "pen" && Math.abs(d.x2 - d.x) < 2 && Math.abs(d.y2 - d.y) < 2) return;
    commitAnnot(d);
  };

  /* 文字输入提交 */
  const submitText = (value: string) => {
    if (textDraft && value.trim()) {
      commitAnnot({
        id: nextId(),
        type: "text",
        color,
        width: LINE_WIDTH,
        x: textDraft.x,
        y: textDraft.y,
        x2: textDraft.x,
        y2: textDraft.y,
        text: value,
        size: TEXT_SIZE,
      });
    }
    setTextDraft(null);
  };

  /* V6.19 自动框选当前窗口（微信同款，设置页可关）：
   * 底图就位后，用光标位置做一次窗口命中 → 自动生成选区。用户可直接完成或重拖。
   * 固定区域恢复的选区优先（已有 sel 则不抢）。 */
  useEffect(() => {
    if (!screen || phase !== "select" || sel) return;
    let cancelled = false;
    void (async () => {
      try {
        const auto = await invoke<boolean>("get_auto_frame_window");
        if (!auto || cancelled) return;
        // get_cursor_pos 与 snap_window_at 都是屏幕坐标，入参直接传；
        // 但返回的矩形是屏幕坐标，而 sel 是底图局部坐标，必须换算。
        const [cx, cy] = await invoke<[number, number]>("get_cursor_pos");
        const hit = await invoke<SnapRect | null>("snap_window_at", { x: cx, y: cy });
        if (
          hit &&
          !cancelled &&
          phaseRef.current === "select" &&
          !selRef.current &&
          hit.w >= 4 &&
          hit.h >= 4
        ) {
          setSel(toLocalRect(screen, hit));
        }
      } catch (e) {
        logger.warn("自动框选当前窗口失败", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, phase, sel]);

  /* V6.19 马赛克/模糊强度滚轮调节（原生 listener，passive:false 才能 preventDefault） */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || phase !== "annotate") return;
    const showHint = (t: string) => {
      setStrengthHint(t);
      if (strengthHintTimerRef.current) window.clearTimeout(strengthHintTimerRef.current);
      strengthHintTimerRef.current = window.setTimeout(() => setStrengthHint(null), 1500);
    };
    const onWheel = (e: WheelEvent) => {
      if (tool === "mosaic") {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -2 : 2;
        setMosaicStrength((v) => {
          const nv = Math.max(4, Math.min(40, v + delta));
          showHint(`马赛克强度：${nv}px · 滚轮调节`);
          return nv;
        });
      } else if (tool === "blur") {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -2 : 2;
        setBlurStrength((v) => {
          const nv = Math.max(2, Math.min(40, v + delta));
          showHint(`模糊强度：${nv}px · 滚轮调节`);
          return nv;
        });
      }
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [phase, tool]);

  /* A 方案：OCR 提前到标注态——选区确定后立即后台识别（选区原始图，不依赖 finalize），
   * 完成复制时文字早已就绪；finish/copyImage 里 `if (!ocr)` 会直接复用，不再等待。 */
  useEffect(() => {
    if (phase !== "annotate" || !screen || ocr || preloadOcrStartedRef.current) return;
    const r = selRef.current;
    if (!r || r.w < 4 || r.h < 4) return;
    preloadOcrStartedRef.current = true;
    setOcrStatus("running");
    void (async () => {
      try {
        const img = await loadImage(screen.dataUrl);
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(r.w));
        out.height = Math.max(1, Math.round(r.h));
        const ctx = out.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
        const dataUrl = out.toDataURL("image/png");
        const tmpPath = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
        // 登记为临时图：它只是喂 OCR 的中间产物（无损 PNG），与最终结果图是两个文件；
        // 不登记的话每截一次图就在 screenshots/ 里永久多留一张全尺寸 PNG。后端关窗时删。
        void invoke("mark_ocr_temp", { path: tmpPath }).catch(() => {});
        const res = await ocrImage(tmpPath);
        if (phaseRef.current !== "annotate" && phaseRef.current !== "result") return;
        setOcr(res);
        if (res.fullText?.trim()) {
          // 有文字：完成胶囊自动滑入（存在感），6s 无操作自动收起
          setOcrStatus("done");
          if (ocrCapsuleTimerRef.current) window.clearTimeout(ocrCapsuleTimerRef.current);
          ocrCapsuleTimerRef.current = window.setTimeout(() => {
            if (!ocrDrawerOpenRef.current) setOcrStatus("idle");
          }, 6000);
        } else {
          setOcrStatus("empty");
        }
      } catch (e) {
        logger.warn("提前 OCR 失败（完成复制时兜底重试）", e);
        setOcrStatus("empty");
      }
    })();
  }, [phase, screen, ocr]);

  /* ===== 渲染 ===== */
  if (!screen) {
    return (
      <div
        className="shot-root"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}
      >
        {captureError ? (
          <div
            style={{
              maxWidth: 420, padding: "14px 18px", borderRadius: 12, fontSize: 12,
              background: "rgba(248,113,113,0.15)", border: "1px solid rgba(248,113,113,0.4)",
              color: "#FCA5A5", lineHeight: 1.7, textAlign: "center",
            }}
          >
            <div>截图失败：{captureError}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: "#2D78C2", color: "#fff", cursor: "pointer", fontSize: 12 }}
                onClick={() => {
                  setCaptureError(null);
                  void invoke<ScreenInfo>("capture_screen")
                    .then(setScreen)
                    .catch((e) => setCaptureError(String(e)));
                }}
              >
                重试
              </button>
              <button
                style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.3)", background: "transparent", color: "#E6EDF7", cursor: "pointer", fontSize: 12 }}
                onClick={() => void invoke("close_screenshot_window")}
              >
                关闭
              </button>
            </div>
          </div>
        ) : (
          <span style={{ fontSize: 13 }}>正在截取屏幕…</span>
        )}
      </div>
    );
  }

  const css = (v: number) => v / dpr;
  const sensitiveKind = ocr ? detectSensitiveText(ocr.fullText) : null;
  const displaySel = selDraft ?? sel;

  // 工具栏位置：贴选区底部外侧（QQ/微信同款）。判断要留足工具栏自身高度（~46px），
  // 否则选区贴近屏幕底时工具栏会溢出被裁掉一小截（V6 实测）。
  const TB_H = 46;
  const toolbarTop = sel
    ? css(sel.y) + css(sel.h) + 8 + TB_H <= window.innerHeight
      ? css(sel.y) + css(sel.h) + 8
      : Math.max(8, css(sel.y) - 8 - TB_H)
    : 8;

  return (
    <div
      className="shot-root"
      onMouseDown={phase === "select" ? onSelectMouseDown : undefined}
      onMouseMove={phase === "select" ? onSelectMouseMove : undefined}
      onMouseUp={phase === "select" ? onSelectMouseUp : undefined}
      onDoubleClick={phase === "select" ? onSelectDoubleClick : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        // 两级取消（规则 17.6，微信同款）：标注态右键 → 回选区态；选区/结果态右键 → 关窗。
        // 与 Esc 同语义，只是给鼠标用户一条等价路径（规则 17.1：鼠标全流程可达）。
        // 此前截图窗口完全没有 onContextMenu，右键是空的。
        if (longShotRef.current) {
          abortLongRef.current = true; // 长截图进行中：先中止滚动，不关窗
          return;
        }
        if (phase === "annotate") {
          setAnnotations([]);
          setUndoStack([]);
          setRedoStack([]);
          setTextDraft(null);
          setSelectedIds([]);
          clearOcrState();
          selFixedRef.current = false; // 解除固定 → hover 吸附恢复，可以重新挑窗口
          setPhase("select");
          return;
        }
        void invoke("close_screenshot_window");
      }}
    >
      {/* 截图底图 */}
      <div className="shot-bg" style={{ backgroundImage: `url(${screen.dataUrl})` }} />

      {/* 选区外暗色遮罩：未选区时全屏微暗提示已进入截图模式（Snipaste 同款）；选区时 4 块压暗 */}
      {phase === "select" && !displaySel && (
        <div
          className="shade-block"
          style={{
            left: 0, top: 0, width: "100%", height: "100%",
            background: "rgba(10, 14, 24, 0.4)",
          }}
        />
      )}
      {displaySel && (
        <>
          <div className="shade-block" style={{ left: 0, top: 0, width: "100%", height: css(displaySel.y) }} />
          <div className="shade-block" style={{ left: 0, top: css(displaySel.y), width: css(displaySel.x), height: css(displaySel.h) }} />
          <div className="shade-block" style={{ left: css(displaySel.x + displaySel.w), top: css(displaySel.y), right: 0, height: css(displaySel.h) }} />
          <div className="shade-block" style={{ left: 0, top: css(displaySel.y + displaySel.h), width: "100%", height: `calc(100% - ${css(displaySel.y + displaySel.h)}px)` }} />
        </>
      )}

      {/* 选区框 + 尺寸角标 */}
      {displaySel && (
        <div
          className="sel-rect"
          style={{ left: css(displaySel.x), top: css(displaySel.y), width: css(displaySel.w), height: css(displaySel.h) }}
        >
          {phase === "select" && (
            <div className="sel-size">
              <span>{Math.round(displaySel.w)} × {Math.round(displaySel.h)}</span>
              <span className="hint">单击进标注 · 拖选区移动 · 拖边缘缩放</span>
            </div>
          )}
          {/* B 方案：select 态选区八向缩放把手（微信同款；拖手柄时 hover 吸附自动暂停） */}
          {phase === "select" && (
            <>
              {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((dir) => (
                <div
                  key={dir}
                  className={`sel-handle h-${dir}`}
                  onMouseDown={onSelHandleDown(dir)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* select 态（未确认选区）不再放任何按钮。
          原来这里挂着「长截图」与「记住为固定区域」，但它们的位置跟着选区走，
          而未确认态下 hover 吸附每 90ms 改写一次选区——按钮一直在跑，实际根本点不到；
          而且「记住固定区域」需要稳定选区、稳定选区又需要先有固定区域，是个死锁。
          对齐微信截图：未确认态只负责选区，两个按钮分别移到标注态工具栏和 ⋯ 面板。 */}

      {/* 标注画布（覆盖选区，物理像素） */}
      {phase !== "select" && sel && (
        <div
          className="annot-wrap"
          style={{ left: css(sel.x), top: css(sel.y), width: css(sel.w), height: css(sel.h) }}
        >
          <canvas
            ref={canvasRef}
            className="annot-canvas"
            width={Math.max(1, Math.round(sel.w))}
            height={Math.max(1, Math.round(sel.h))}
            style={{
              width: css(sel.w),
              height: css(sel.h),
              // 光标随工具变化：文字=I-beam、橡皮擦=方块、其余=十字（强化切换感知）
              cursor: tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair",
            }}
            onMouseDown={phase === "annotate" ? onAnnotMouseDown : undefined}
            onMouseMove={phase === "annotate" ? onAnnotMouseMove : undefined}
            onMouseUp={phase === "annotate" ? onAnnotMouseUp : undefined}
            onDoubleClick={phase === "annotate" ? onAnnotDoubleClick : undefined}
          />
          {/* 标注态把手：单选选中元素 → 元素缩放把手；否则 → 选区调整把手（多选只移动/删除） */}
          {phase === "annotate" &&
            (selectedIds.length === 1 ? (
              (() => {
                const a = annotations.find((x) => x.id === selectedIds[0]);
                if (!a) return null;
                const ax = Math.min(a.x, a.x2);
                const ay = Math.min(a.y, a.y2);
                const aw = Math.abs(a.x2 - a.x);
                const ah = Math.abs(a.y2 - a.y);
                const dirs =
                  a.type === "pen" || a.type === "arrow"
                    ? ["nw", "ne", "se", "sw"]
                    : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
                return dirs.map((dir) => (
                  <div
                    key={dir}
                    className={`sel-handle h-${dir}`}
                    style={{ left: css(ax), top: css(ay), width: css(aw), height: css(ah) }}
                    onMouseDown={onAnnotHandleDown(dir)}
                  />
                ));
              })()
            ) : (
              ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((dir) => (
                <div
                  key={dir}
                  className={`sel-handle h-${dir}`}
                  onMouseDown={onSelHandleDown(dir)}
                />
              ))
            ))}
          {/* OCR 行级高亮框（标注/结果态，点击复制该行——A 方案标注态即融入） */}
          {ocr?.lines.map((line, i) => {
              const w = line.words[0];
              if (!w) return null;
              return (
                <div
                  key={i}
                  className={`ocr-line${phase === "annotate" ? " inert" : ""}${copiedRow === i ? " copied" : ""}`}
                  style={{ left: css(w.x), top: css(w.y), width: css(w.width), height: css(w.height) }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void copyRow(i)}
                >
                  <span className="tip">{copiedRow === i ? "已复制 ✓" : "点击复制此行"}</span>
                </div>
              );
            })}
          {/* 文字标注输入框 */}
          {textDraft && (
            <input
              autoFocus
              className="text-draft"
              style={{ left: css(textDraft.x), top: css(textDraft.y), fontSize: TEXT_SIZE / dpr }}
              placeholder="输入文字…"
              onBlur={(e) => submitText(e.target.value)}
              onKeyDown={(e) => {
                // 必须阻断冒泡：否则 Enter 会触发全局"完成标注"、Esc 会关闭截图窗口（V3 bug）
                // isComposing：中文输入法选词按 Enter 不应提交（V6 实测 bug）
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.stopPropagation();
                  submitText((e.target as HTMLInputElement).value);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setTextDraft(null);
                }
              }}
            />
          )}
        </div>
      )}

      {/* 顶部提示条：标注态隐藏（QQ/微信同款：标注时界面清爽，且避免遮挡工具栏） */}
      {phase !== "annotate" && (
        <div className="shot-hint">
          {phase === "select" ? (
            <>
              <span>拖拽框选 · 松手自动标注 · 悬停窗口可吸附</span>
              <span>双击 = 全选</span>
              <kbd>Esc</kbd> 取消
            </>
          ) : (
            <>
              <span>截图完成 · 点击下方出口操作</span>
              <kbd>Esc</kbd> 关闭
            </>
          )}
        </div>
      )}

      {/* 标注工具栏 */}
      {phase === "annotate" && sel && (
        <div className="annot-toolbar" style={{ top: toolbarTop }}>
          {TOOLS.map((t) => (
            <div
              key={t.id}
              className={`tool${tool === t.id ? " on" : ""}`}
              data-tip={`${t.label}${t.key ? `（按 ${t.key}）` : ""}`}
              onClick={() => {
                // 吸管激活时记住上一个工具（点击复制后自动恢复）
                if (t.id === "picker" && tool !== "picker") pickerPrevToolRef.current = tool;
                setTool(t.id);
              }}
            >
              {t.icon}
              {t.key && <span className="kbd">{t.key}</span>}
            </div>
          ))}
          <div className="tsep" />
          <div className="tool-colors" data-tip="标注颜色">
            {COLORS.map((c) => (
              <span
                key={c}
                className={`cp${color === c ? " on" : ""}`}
                style={{ background: c }}
                title=""
                data-tip={c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="tsep" />
          {/* 箭头样式切换（V6.19：单箭头 / 双箭头） */}
          <div
            className={`tool${arrowStyle === "double" ? " on" : ""}`}
            data-tip={arrowStyle === "double" ? "双箭头（点击切单箭头）" : "单箭头（点击切双箭头）"}
            onClick={() => setArrowStyle(arrowStyle === "single" ? "double" : "single")}
            style={{ color: "var(--text-muted)" }}
          >
            {arrowStyle === "double" ? (
              <svg viewBox="0 0 16 16"><path d="M3 5.5l2-2v3H3zM13 5.5l-2-2v3h2z" fill="currentColor" /><path d="M4 8h8" stroke="currentColor" strokeWidth="1.5" /></svg>
            ) : (
              <svg viewBox="0 0 16 16"><path d="M13 5.5l-2-2v3h2z" fill="currentColor" /><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" /></svg>
            )}
          </div>
          <div className="tool" data-tip="撤销（Ctrl+Z）" onClick={undo} style={{ color: "var(--text-muted)" }}>
            <svg viewBox="0 0 16 16"><path d="M3 6h7a3.5 3.5 0 1 1 0 7H6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6.5 3L3 6l3.5 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          </div>
          <div className="tool" data-tip="重做（Ctrl+Y）" onClick={redo} style={{ color: "var(--text-muted)" }}>
            <svg viewBox="0 0 16 16"><path d="M13 6H6a3.5 3.5 0 1 0 0 7h4" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9.5 3L13 6l-3.5 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          </div>
          <div className="tsep" />
          {/* 长截图（从 select 态移来）：它是输出类动作而非标注工具，所以靠 tsep 与标注工具分开
              （QQ 截图同样把它归在完成/保存这一组）。颜色沿用原 .longshot-btn 的 #8cc5ff。
              ⚠️ 已有标注时必须禁用：startLongShot 走的是 finalizeCanvas，不合成 annotations，
              此时点它会把先画的标注静默丢掉；禁用原因写在 data-tip 里（规则 15.3：不静默）。 */}
          <div
            className={`tool${annotations.length > 0 || longShot ? " disabled" : ""}`}
            data-tip={
              annotations.length > 0
                ? "已有标注，长截图会丢弃它们 · 先撤销或完成"
                : "长截图 · 滚动拼接"
            }
            style={{ color: "#8cc5ff" }}
            onClick={() => {
              if (annotations.length > 0 || longShot) return;
              void startLongShot();
            }}
          >
            <svg viewBox="0 0 16 16">
              <path d="M8 2v9" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <path d="M4.5 8L8 11.5 11.5 8" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <path d="M3 14h10" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </div>
          <div className="tool done-btn" data-tip="完成并复制（Enter / 双击画布）" onClick={() => void copyImage()}>完成 ✓</div>
          <div className="tool more-btn" data-tip="更多出口（保存 / 贴图 / AI / 翻译）" onClick={() => void finish()}>⋯</div>
        </div>
      )}

      {/* 吸管取色色值条（V6.19：移动即显示光标处颜色，点击画布复制） */}
      {tool === "picker" && pickerColor && (
        <div className="picker-bar">
          <span className="sw" style={{ background: pickerColor }} />
          <span className="hex">{pickerColor}</span>
          <span className="hint">点击画布复制该颜色 · 复制后自动回到原工具</span>
        </div>
      )}
      {/* V6.19 马赛克/模糊强度提示（滚轮调节） */}
      {strengthHint && (
        <div className="picker-bar" style={{ borderColor: "rgba(99,102,241,0.45)" }}>
          <span>{strengthHint}</span>
        </div>
      )}
      {/* A 方案：完成复制后的文字 toast（点击复制全文） */}
      {ocrToast && (
        <div
          className="picker-bar"
          style={{ cursor: "pointer", borderColor: "rgba(34,197,94,0.55)", bottom: 64 }}
          onClick={async () => {
            const content = ocrToastCopyRef.current ?? (ocr ? ocr.fullText : "");
            if (content) {
              await copyText(content);
              setOcrToast(null);
            }
          }}
        >
          <span>📄 {ocrToast}</span>
        </div>
      )}

      {/* A 方案增强：OCR 识别过程可见——识别中指示 / 完成胶囊（自动滑入，点击展开抽屉） */}
      {phase === "annotate" && ocrStatus === "running" && (
        <div className="ocr-pill">
          <span className="spinner" />
          识别文字中…
        </div>
      )}
      {phase === "annotate" && ocrStatus === "done" && !ocrDrawerOpen && ocr && (
        <div
          className="ocr-pill"
          onClick={() => {
            setOcrDrawerOpen(true);
            setOcrStatus("idle");
          }}
        >
          📄 识别到 {ocr.lines.length} 行文字 · 点击查看
        </div>
      )}
      {/* OCR 结果抽屉 */}
      {(phase === "result" || ocrDrawerOpen) && ocr && (
        <div className="ocr-drawer">
          <div className="ocr-head">
            <span>OCR 识别 · {ocr.lines.length} 行</span>
            <span className="sp" />
            <button className={`copy-all${copiedAll ? " done" : ""}`} onClick={() => void copyAllText()}>
              {copiedAll ? "已复制 ✓" : "复制全文"}
            </button>
          </div>
          {qr && (
            <div className="qr-bar">
              <span className="qr-ic">▦</span>
              <span className="qr-tx" title={qr}>{qr.length > 48 ? qr.slice(0, 48) + "…" : qr}</span>
              <button className="qr-btn" onClick={() => { void copyText(qr); setQrCopied(true); setTimeout(() => setQrCopied(false), 1200); }}>
                {qrCopied ? "已复制 ✓" : "复制"}
              </button>
              {/^https?:\/\//i.test(qr) && (
                <button className="qr-btn" onClick={() => void invoke("open_url", { url: qr }).catch((e) => logger.warn("打开链接失败", e))}>
                  打开
                </button>
              )}
            </div>
          )}
          <div className="ocr-body">
            {ocr.lines.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 4px" }}>未从图片识别到文字</div>
            ) : (
              ocr.lines.map((line, i) => (
                <div key={i} className={`ocr-row${copiedRow === i ? " copied" : ""}`} onClick={() => void copyRow(i)}>
                  <span className="n">{i + 1}</span>
                  <span className="tx">{line.text}</span>
                </div>
              ))
            )}
          </div>
          <div className="ocr-foot">
            <button className="fbtn" onClick={() => void copyAllText()}>
              {copiedAll ? "已复制 ✓" : "复制全部"}
            </button>
            <button className="fbtn" onClick={openOcrEdit}>编辑文本</button>
            <button className="fbtn" onClick={openTable}>提取表格</button>
            {/* 设计稿对齐：OCR 文字级快捷出口（AI / 动作链，含敏感内容确认） */}
            {/* 规则 16：AI 未启用时必须零可见——不能渲染出来再靠函数里 early return，
                那是「点了没反应」的静默失败（又踩规则 15.3）。
                送动作链不跟 aiOk 走：纯本地链在 AI 关着时照样可用，细粒度控制放在弹层里。 */}
            {aiOk && (
              <button className="fbtn ai" onClick={() => void openAi()}>AI 解释</button>
            )}
            <button className="fbtn chain" onClick={() => void openChains()}>送动作链</button>
            <button className="fbtn" onClick={close}>完成</button>
          </div>
        </div>
      )}

      {/* V4：表格识别结果弹层 */}
      {tableOpen && (
        <div className="pop-layer">
          <div className="pop-head">
            <span>表格识别 · OCR 几何提取</span>
            <span className="sp" />
            <button className="xbtn" onClick={() => setTableOpen(false)}>✕</button>
          </div>
          {tableErr ? (
            <>
              <div className="pop-result err">{tableErr}</div>
              <div className="pop-foot"><button className="fb" onClick={() => setTableOpen(false)}>关闭</button></div>
            </>
          ) : (
            <>
              <div style={{ padding: "4px 12px 0", fontSize: 10, color: "var(--text-muted)" }}>
                基于 OCR 坐标的几何识别：整齐表格效果好，合并单元格可能失真
              </div>
              <textarea readOnly className="table-out" value={tableCsv} spellCheck={false} />
              <div className="pop-foot">
                <button className="fb primary" onClick={() => void copyTableCsv()}>
                  {tableCopied ? "已复制 ✓" : "复制 CSV"}
                </button>
                <button className="fb" onClick={() => setTableOpen(false)}>关闭</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* V6.19：OCR 文本编辑弹层（改错字再复制） */}
      {ocrEditOpen && (
        <div className="pop-layer">
          <div className="pop-head">
            <span>编辑识别文本</span>
            <span className="sp" />
            <button className="xbtn" onClick={() => setOcrEditOpen(false)}>✕</button>
          </div>
          <div style={{ padding: "4px 12px 0", fontSize: 10, color: "var(--text-muted)" }}>
            修正 OCR 错字后复制（微信 OCR 面板同款）
          </div>
          <textarea
            autoFocus
            className="ocr-edit-out"
            value={ocrEditText}
            onChange={(e) => setOcrEditText(e.target.value)}
            spellCheck={false}
          />
          <div className="pop-foot">
            <button className="fb primary" onClick={() => void copyOcrEdited()}>
              {ocrEditCopied ? "已复制 ✓" : "复制修改后的文本"}
            </button>
            <button className="fb" onClick={() => setOcrEditOpen(false)}>关闭</button>
          </div>
        </div>
      )}

      {/* 结果动作面板 */}
      {phase === "result" && (
        <div className="act-panel">
          <div className="act-head"><span className="dot" /> 截图完成 · 选择出口</div>
          {sensitiveKind && (
            <div
              style={{
                padding: "6px 12px", fontSize: 11, lineHeight: 1.5,
                color: "#F87171", background: "rgba(248,113,113,0.12)",
                borderBottom: "1px solid rgba(248,113,113,0.25)",
              }}
            >
              ⚠️ 检测到疑似敏感内容（{sensitiveKind}），AI / 云端出口已拦截，需确认后才发送
            </div>
          )}
          <div className="act-row primary" onClick={() => void copyImage()}>
            <span className="ic">⬡</span>
            <span>
              <div className="lbl">复制图片</div>
              <div className="sub">写入剪贴板历史</div>
            </span>
            <span className="k">Ctrl+C</span>
          </div>
          <div className="act-row" onClick={() => void saveToGallery()}>
            <span className="ic">⬇</span>
            <span>
              <div className="lbl">保存到图库</div>
              <div className="sub">另存为图片文件</div>
            </span>
            <span className="k">Ctrl+S</span>
          </div>
          <div className="act-row pin" onClick={pinImage}>
            <span className="ic">📌</span>
            <span>
              <div className="lbl">贴图置顶</div>
              <div className="sub">钉在屏幕上</div>
            </span>
          </div>
          {/* 规则 16：这两项必然走云端，AI 未启用时不渲染（零可见） */}
          {aiOk && (
            <div className="act-row ai" onClick={() => void openAi()}>
              <span className="ic">AI</span>
              <span>
                <div className="lbl">AI 处理</div>
                <div className="sub">解释 / 翻译 / 总结</div>
              </span>
            </div>
          )}
          {aiOk && (
            <div className="act-row ai" onClick={() => void translateShot()}>
              <span className="ic">译</span>
              <span>
                <div className="lbl">翻译</div>
                <div className="sub">识别文字翻译成中文</div>
              </span>
              <span className="k">⚡</span>
            </div>
          )}
          <div className="act-row chain" onClick={() => void openChains()}>
            <span className="ic">⚡</span>
            <span>
              <div className="lbl">送动作链</div>
              <div className="sub">对识别文字跑自定义链</div>
            </span>
          </div>
          {/* 固定区域（从 select 态移来）：低频操作，不占工具栏横向空间。
              已有固定区域时变为「清除」，给它一个能被发现的出口（否则只能靠右键回退）。 */}
          <div className="act-row" onClick={hasFixedRegion ? clearRegion : saveRegion}>
            <span className="ic">🔒</span>
            <span>
              <div className="lbl">
                {hasFixedRegion
                  ? "清除固定区域"
                  : regionSaved
                    ? "✓ 已记住此区域"
                    : "记住为固定区域"}
              </div>
              <div className="sub">
                {hasFixedRegion ? "恢复自动吸附" : "下次截图直接用这块区域"}
              </div>
            </span>
          </div>
          <div className="act-row" onClick={reselect}>
            <span className="ic">↺</span>
            <span>
              <div className="lbl">重新截图</div>
              <div className="sub">重选区域</div>
            </span>
          </div>
          {/* V6.19 第二梯队：截图插入当前编辑文档（编辑器打开时显示） */}
          {editorTarget && (
            <div
              className="act-row"
              style={{ border: "1px solid rgba(34,211,238,0.45)", background: "rgba(34,211,238,0.07)" }}
              onClick={() => void insertToEditor()}
            >
              <span className="ic">📝</span>
              <span>
                <div className="lbl">插入到当前文档</div>
                <div className="sub">{editorTarget.split(/[\\/]/).pop()}</div>
              </span>
              <span className="k">Ctrl+Enter</span>
            </div>
          )}
        </div>
      )}

      {/* ===== V2：AI 处理弹层 ===== */}
      {aiOpen && (
        <div className="pop-layer">
          <div className="pop-head">
            <span>AI 处理识别文字{ocrText() ? "" : " · 无文字"}</span>
            <span className="sp" />
            <button className="xbtn" onClick={closeAi}>✕</button>
          </div>
          {aiRes?.status === "ok" && (
            <>
              <div className="pop-result">
                <div className="meta">{aiRes.meta}</div>
                {aiRes.content}
              </div>
              <div className="pop-foot">
                <button className="fb primary" onClick={() => void copyAiResult()}>
                  {copiedOut ? "已复制 ✓" : "复制结果"}
                </button>
                <button className="fb" onClick={closeAi}>关闭</button>
              </div>
            </>
          )}
          {aiRes?.status === "running" && (
            <div className="pop-body"><div className="pop-empty">{aiRes.message}</div></div>
          )}
          {aiRes?.status === "error" && (
            <>
              <div className="pop-result err">{aiRes.message}</div>
              <div className="pop-foot"><button className="fb" onClick={closeAi}>关闭</button></div>
            </>
          )}
          {aiRes?.status === "confirm" && (
            <>
              <div className="pop-confirm">
                ⚠️ {aiRes.confirmReason}
                <br />
                <span style={{ opacity: 0.7, fontSize: 11 }}>继续会消耗额度并调用云端。</span>
              </div>
              <div className="pop-foot">
                <button
                  className="fb primary"
                  onClick={() => {
                    const a = lastAiActionRef.current;
                    if (a) void runAiAction(a, true);
                  }}
                >
                  继续
                </button>
                <button className="fb" onClick={closeAi}>取消</button>
              </div>
            </>
          )}
          {(!aiRes || aiRes.status === "idle") && (
            <div className="pop-body">
              {aiActions.length === 0 ? (
                <div className="pop-empty">加载动作清单中…</div>
              ) : (
                aiActions.map((a) => (
                  <div
                    key={a.id}
                    className={`pop-row${aiBusyId === a.id ? " busy" : ""}`}
                    onClick={() => aiBusyId ? undefined : void runAiAction(a)}
                  >
                    <span className="ic">{a.icon || "✦"}</span>
                    <span>
                      <div className="lbl">{a.label}</div>
                      <div className="dsc">{a.description}</div>
                    </span>
                    <span className="net">✦ 云端</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== V2：送动作链弹层 ===== */}
      {chainOpen && (
        <div className="pop-layer">
          <div className="pop-head">
            <span>动作链 · 对识别文字{ocrText() ? "" : " · 无文字"}</span>
            <span className="sp" />
            <button className="xbtn" onClick={closeChains}>✕</button>
          </div>
          {chainRes && (
            <>
              <div className="pop-result">
                <div className="meta">
                  {chainRes.ok
                    ? "✓ 执行成功"
                    : `✗ 在第 ${(chainRes.failedAt ?? 0) + 1} 步失败：${chainRes.stages[chainRes.failedAt ?? 0]?.error ?? "未知错误"}`}{" "}
                  · {chainRes.stages.length} 步
                </div>
                {chainRes.final}
              </div>
              <div className="pop-foot">
                <button className="fb primary" onClick={() => void copyChainFinal()}>
                  {copiedOut ? "已复制 ✓" : "复制结果"}
                </button>
                <button className="fb" onClick={closeChains}>关闭</button>
              </div>
            </>
          )}
          {chainErr && (
            <>
              <div className="pop-result err">{chainErr}</div>
              <div className="pop-foot"><button className="fb" onClick={closeChains}>关闭</button></div>
            </>
          )}
          {!chainRes && !chainErr && (
            <div className="pop-body">
              {chains.length === 0 ? (
                <div className="pop-empty">还没有自定义动作链，去主窗口「动作链」里创建</div>
              ) : (
                chains.map((c) => {
                  // 规则 16：含云端步骤的链在 AI 未启用时不可点，并把原因写在副标题里
                  // （规则 15.3：不能静默）；纯本地链不受影响。
                  const blocked = !aiOk && chainNeedsAi(c);
                  return (
                  <div
                    key={c.id}
                    className={`pop-row${chainBusyId === c.id ? " busy" : ""}${blocked ? " disabled" : ""}`}
                    onClick={() => (chainBusyId || blocked ? undefined : void runChainAction(c))}
                  >
                    <span className="ic">⚡</span>
                    <span>
                      <div className="lbl">{c.name}</div>
                      <div className="dsc">
                        {blocked
                          ? "含云端步骤 · 需先在设置里开启 AI"
                          : c.description || `${c.steps.length} 步`}
                      </div>
                    </span>
                  </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* 像素放大镜 + 取色（select 态拖选中显示） */}
      <div
        ref={magRef}
        className="mag-view"
        style={{ display: "none" }}
        onClick={() => void copyHex()}
      >
        <canvas
          ref={magCanvasRef}
          className="mag-canvas"
          width={MAG_SIZE}
          height={MAG_SIZE}
          style={{ width: MAG_SIZE / dpr, height: MAG_SIZE / dpr }}
        />
        <span className="mag-info" ref={magInfoRef} />
      </div>
    </div>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* 长截图：滚动后等画面稳定的参数（取代固定 sleep(280)）。
 * 固定 280ms × 40 帧 = 11.2 秒纯等待，快页面也得陪着等；
 * 改成轮询后快页面 60~120ms 就走，慢页面最多等 400ms（比原来还宽松，不会截糊）。 */
const STABLE_STEP_MS = 60;
const STABLE_MAX_MS = 400;
const STABLE_PROBE_W = 240;

