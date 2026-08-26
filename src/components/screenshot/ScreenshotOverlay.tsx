/**
 * ScreenshotOverlay — 截图标注全流程组件（选区 → 标注 → OCR 融入 → 结果出口）。
 *
 * 坐标系约定（与后端 screenshot.rs 一致）：
 * - 全程物理像素；前端 CSS 显示尺寸 = 物理 / devicePixelRatio；
 * - 鼠标 CSS 坐标 × dpr = 物理坐标；
 * - 标注画布 bitmap = 选区物理尺寸，CSS 尺寸 = 物理 / dpr，内部绘制用物理坐标；
 * - OCR 行框坐标相对选区图（合成后的图），与标注画布同坐标系，天然对齐。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { ocrImage, type OcrResult } from "@/lib/api/images";
import { aiListActions, aiRun, type AiActionMeta, type AiRunResponse } from "@/lib/api/ai";
import { chainList, type ChainDef } from "@/lib/api/chains";
import { runChain } from "@/lib/chains/registry";
import { chainNeedsAi } from "@/lib/screenshot/chains";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { useAiStatus } from "@/hooks/useAiStatus";
import type { Chain, ChainRunResult } from "@/lib/chains/types";
import { logger } from "@/lib/logger";
// 模块级助手与常量已外迁（claude.md §7 行数上限）：imageIo 是与 React 无关的图片/异步 IO，
// shotConstants 是不随渲染变化的常量表。纯搬运，行为未变。
import {
  canvasToDataUrl,
  errText,
  loadImage,
  saveResultImage,
  sleep,
} from "@/lib/screenshot/imageIo";
import {
  ATTR_BAR_H,
  ATTR_TOOLS,
  ERASER_RADIUS_SCALE,
  LONG_OCR_MAX_H,
  NO_COLOR_TOOLS,
  OCR_PANEL_W,
  PENDING_POLL_MS,
  PENDING_WAIT_MS,
  PIN_FLOAT_H,
  PIN_FLOAT_W,
  SHAPE_TOOLS,
  TEXT_SIZE_TOOLS,
  WIDTH_TOOLS,
} from "@/lib/screenshot/shotConstants";
import { TooltipLayer } from "./TooltipLayer";
import { MAG_SIZE, useMagnifier } from "./hooks/useMagnifier";
import { useLongShot } from "./hooks/useLongShot";
import { nextId } from "@/lib/screenshot/annotId";
import { useAutoMask, type MaskBox } from "./hooks/useAutoMask";
// 纯计算已抽到 lib/screenshot/（规则 7）——那里才能写回归测试：
// 坐标换算与磁吸曾各藏过一个真 bug，长截图重叠匹配曾把 G/B 通道索引写错。
import {
  applyMagnet,
  clampRect,
  DRAG_MIN,
  eraseStrokes,
  nearestInDirection,
  isSelectableAnnot,
  pointHitAnnot,
  resolveSnapTargets,
  sortControlsVisual,
  toLocalRect,
  toScreenPt,
  toScreenRect,
} from "@/lib/screenshot/geometry";
import type { Dir } from "@/lib/screenshot/geometry";
import { removeTiledWatermarkRegion } from "@/lib/screenshot/dewarp";
import {
  contrastInk,
  drawAnnot,
  inDrawOrder,
  measureTextExtent,
  TEXT_LINE_HEIGHT,
  wrapLines,
} from "@/lib/screenshot/draw";
import { isRowMasked } from "@/lib/screenshot/maskGeom";
import { layoutToolbar, modePillPos } from "@/lib/screenshot/toolbarPos";
import { layoutOcrCopyBar } from "@/lib/screenshot/ocrBarPos";
import {
  pointInAnyWord,
  shouldStartOcrSelect,
  selectSpan,
  selectLine,
} from "@/lib/screenshot/ocrSelect";
import { lineBox } from "@/lib/screenshot/ocrTable";
import { layoutSidePanel } from "@/lib/screenshot/panelPos";
import { layoutSizeLabel } from "@/lib/screenshot/sizeLabelPos";
import { samplePixelHex } from "@/lib/screenshot/pixelProbe";
import type { OcrSelectMode } from "@/lib/screenshot/types";
import {
  LONGSHOT_CONTROL,
  type LongShotControl,
} from "@/lib/screenshot/longshotEvents";

import { AnnotToolbar } from "./AnnotToolbar";
import { TextToolbar } from "./TextToolbar";
import { AttrBar, type MaskShape, type TextSizeId, type WidthId } from "./AttrBar";
import { OcrDrawer } from "./OcrDrawer";
import { OcrEditPopover, TablePopover } from "./TextPopovers";
import { AiPopover, ChainPopover, type PopRun } from "./AiChainPopovers";
import { ResultActions } from "./ResultActions";
import { ModePill } from "./ModePill";
// 组件自身仍需要：COLORS 定初始颜色，TOOL_BY_KEY 供数字键切工具（快捷键不经过工具栏），
// WIDTHS 把粗细档位换算成像素
import { BLUR_LEVELS, COLORS, DEWARP_LEVELS, MOSAIC_LEVELS, TEXT_SIZES, TOOL_BY_KEY, WIDTHS } from "./tools";
import { csvEscape, ocrToTable } from "@/lib/screenshot/ocrTable";
import { detectSensitiveText } from "@/lib/screenshot/sensitive";
import type {
  Annotation,
  ControlList,
  Rect,
  ScreenInfo,
  SnapRect,
  SnapTargets,
  ToolId,
} from "@/lib/screenshot/types";

/* ===== 类型（仅本组件用的那几个；共享类型在 lib/screenshot/types） ===== */

type Phase = "select" | "annotate" | "result";

/* 文字输入框的视觉内边距（CSS px）。
 *
 * ❗ 它必须同时出现在两个地方：padding: TEXT_PAD 与 left/top 各减 TEXT_PAD。
 * 两者相消后，文字的屏幕位置与落字位置严格相等，而视觉上字不再顶着框线。
 * 只改其中一处 = 预览与落字错位（这正是当初把 padding 写死为 0 的原因）。 */
const TEXT_PAD = 4;


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
  // 线宽档位（旧实现用写死的 LINE_WIDTH = 3，用户改不了）
  const [widthId, setWidthId] = useState<WidthId>("mid");
  /** 字号档位（文字 / 序号）。旧实现根本没有这个——字号写死 18 物理像素，
   *  高 DPI 屏上只有 7~12 CSS 像素，就是用户反馈的“文字工具看不到任何东西”。 */
  const [textSizeId, setTextSizeId] = useState<TextSizeId>("md");
  /** 遮罩类工具的形状，**每个工具各自记住**。
   *
   *  不共用一个值的理由：高亮几乎总是沿文字行涂，而马赛克偶尔要拖一大块
   *  遮整片区域——共用会让用户每次切工具都要重新选一次形状。 */
  const [maskShapes, setMaskShapes] = useState<Record<string, MaskShape>>({
    mosaic: "brush",
    blur: "brush",
    highlight: "brush",
    dewarp: "brush",
  });
  // 主栏尺寸实测：宽度随工具数量与按钮文案（完成 ✓ / 处理中…）变化，
  // 写死会让"右对齐选区右边缘"算错。初值是估算，首帧后按真实值修正。
  const tbRef = useRef<HTMLDivElement>(null);
  const [tbSize, setTbSize] = useState({ w: 660, h: 54 });
  // OCR 模式胶囊尺寸实测：文本态（智能意图 / Ctrl）宽度不同，右对齐选区右缘要真值
  const pillRef = useRef<HTMLDivElement>(null);
  const [pillSize, setPillSize] = useState({ w: 88, h: 28 });
  // result 态出口面板同理：高度随出口数量变（AI 开关、编辑器是否打开都会影响），必须实测
  /** 橡皮光标层：**独立于标注画布**的一张透明 canvas。
   *
   *  为什么不画在标注画布上：那样每次 mousemove 都得重绘所有标注
   *  （选区大、标注多时是真开销），而现在只有拖动时才重绘。
   *  单独一层的话 hover 只需清空这一层再描一个圆，开销可忽略。
   *
   *  也不用 CSS 自定义光标（SVG data URL）：橡皮最大档半径 lineW×6 = 30 物理像素，
   *  dpr 1.5 下直径 40 CSS 像素，超过 Windows 光标的安全尺寸上限（通常 32×32），
   *  粗档会被截断或干脆不显示。 */
  const eraserCurRef = useRef<HTMLCanvasElement>(null);
  const actRef = useRef<HTMLDivElement>(null);
  const [actSize, setActSize] = useState({ w: 224, h: 300 });
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 出口反馈提示（成功绿 / 失败红，3 秒自动消失）。
   *  规则 15.3：finish / copyImage / 保存 / 贴图 这些出口原来失败只写 logger，
   *  UI 零反馈，用户看到的就是"点了没反应"。 */
  const [shotToast, setShotToast] = useState<{ text: string; ok: boolean } | null>(null);
  const shotToastTimerRef = useRef<number | null>(null);
  // 文字输入框状态。id 有值 = 正在编辑已有文字（微信：点/双击已有文字=改字）；
  // value 是回填到输入框的初始文本。无 id = 新建文字。
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; id?: number; value?: string } | null>(null);
  /** 文字输入框 DOM 引用：用 rAF 聚焦代替 autoFocus（见下方 effect 注释）。 */
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  /** 文字输入框真实渲染高度（CSS px，含 padding/border；border-box 下即框整体高）。
   *  由 autoSizeText 撑高后实测写入，工具条定位与翻转判断改用它——替代原先按"占满选区宽"
   *  估算的 boxHCss。方案 A 让框宽从 120px 起、随输入增长，真实行数/框高随之变化，估算值
   *  严重偏低会把工具条算到输入框上半截（重叠）；用 DOM 实测高度则框变高工具条实时下移，永不重叠。 */
  const [textBoxHCss, setTextBoxHCss] = useState(0);
  /** 防止文字被重复提交：Enter 提交 / Esc 取消后，卸载时的 blur 不应再提交一次。
   *  Enter 提交后浏览器可能补发一次 blur（导致落两份相同文字）；
   *  Esc 取消本意是不提交，但 blur 也会触发 onBlur→submitText（变成"取消却落字"）。
   *  两者都用这个标记拦截。每次进入新编辑会话（textDraft 变化）由下方 effect 重置。 */
  const textSubmittedRef = useRef(false);
  // 内容变化时自适应尺寸：
  //  · 高度按 scrollHeight 撑开（避免多行被裁切）；
  //  · 宽度随内容增长（方案 A）：临时解除 max-width + 不换行，读 scrollWidth 得到“不折行
  //    自然宽”，把框宽设回它——上限由 JSX 的 max-width（选区剩余宽）封顶、下限由 CSS 的
  //    min-width(120) 保底。这样字少时框是一般长度，越打越宽，到选区边界才原生换行、高度继续涨。
  //  用 DOM 实测而非 measureTextExtent：避免引用组件内 fontPx/dpr（声明在函数之后，会 TDZ），
  //  也无需把本函数塞进 effect 依赖（否则每次渲染重建聚焦 effect、反复抢焦点）。
  const autoSizeText = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    setTextBoxHCss(el.offsetHeight); // 实测真实框高（含 padding/border），工具条据此定位
    const prevWS = el.style.whiteSpace;
    const prevMax = el.style.maxWidth;
    el.style.whiteSpace = "nowrap";
    el.style.maxWidth = "none";
    const natWcss = el.scrollWidth; // 含 padding（border-box），即不折行时最宽行宽
    el.style.whiteSpace = prevWS;
    el.style.maxWidth = prevMax;
    el.style.width = `${natWcss}px`;
  }, []);
  // 标注态点画面创建输入框是在 mousedown handler 里触发的；浏览器会在 mouseup 时执行
  // mousedown 的默认聚焦行为，把刚 autoFocus 的输入框 blur 掉，进而触发 onBlur →
  // submitText("") → setTextDraft(null)，输入框在渲染后不到一帧就被移除（Tauri/WebView 经典坑）。
  // 因此这里不用 autoFocus，改为在手势结束后（rAF）聚焦，彻底避开竞态，比 autoFocus 更可靠。
  useEffect(() => {
    if (!textDraft) return;
    // 进入新编辑会话：清除上一次的"已提交/已取消"标记，避免误拦截本次提交。
    textSubmittedRef.current = false;
    setTextBoxHCss(0); // 重置真实框高，避免上一个框的高度残留到本次（首帧用估算兜底）
    const el = textInputRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.focus();
      // 回填的已有文字可能多行，挂载后立即撑开高度（onChange 只覆盖用户编辑时）
      autoSizeText(el);
    });
    return () => cancelAnimationFrame(id);
  }, [textDraft, autoSizeText]);
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  // ⑤ 取文字 · 字级拖选：逐字符可选中（后端已返回逐字符 bbox）。
  // ocrSel 存字符 key `${行}-${字}`；ocrDrag 是橡皮筋矩形（物理像素）；ocrBarOpen 弹浮复制条。
  const [ocrSel, setOcrSel] = useState<Set<string>>(new Set());
  const [ocrDrag, setOcrDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ocrBarOpen, setOcrBarOpen] = useState(false);

  const ocrDragRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    key: string;
    mode: OcrSelectMode;
  } | null>(null);
  const ocrRectsRef = useRef<{ key: string; x: number; y: number; w: number; h: number; ch: string }[]>([]);
  const ocrBarOpenRef = useRef(false);
  const ocrSelRef = useRef<Set<string>>(new Set());

  // OCR 选字模式（标注态共存逻辑）。
  //
  // ❌ 不能读 appStore：截图窗是**独立 webview**（screenshot-main.tsx，自己的 JS 上下文），
  // 与主窗不共享 zustand store，而这边又从来不跑 主窗的配置加载——读到的永远是
  // DEFAULT_CONFIG，设置页怎么调这边都不变。其它独立窗口（RichFullscreen /
  // QuickPastePanel / FullscreenEditor）早就是这么写的：走 get_config。
  const [ocrSelectMode, setOcrSelectMode] = useState<OcrSelectMode>("smart");
  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((cfg) => {
        const m = cfg?.ocr_select_mode;
        if (m === "smart" || m === "modifier") setOcrSelectMode(m);
      })
      .catch((e) => logger.warn("读取 OCR 选字模式失败，用默认值", e));
  }, []);
  /** 改模式：先本窗生效，再落盘。
   *  save_config 是按键 upsert（config.rs），传一个字段就只写这一个键，
   *  不会覆盖主窗的其它配置；不落盘的话关窗就丢了。 */
  const changeOcrSelectMode = useCallback((m: OcrSelectMode) => {
    setOcrSelectMode(m);
    void invoke("save_config", { config: { ocr_select_mode: m } }).catch((e) =>
      logger.warn("保存 OCR 选字模式失败（本次截图仍生效）", e),
    );
  }, []);
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
  // 固定区域「预览即默认」（P1）：恢复固定区域不再静默进标注，改用虚线紫框预览（单击采纳 / 拖改 / Esc 重置）
  const [fixedPreview, setFixedPreview] = useState(false);
  const fixedPreviewRef = useRef(false);
  // 自动打码「预览式」（P3）：检测后先橙色虚框轻预览，逐框可排除，确认才打马赛克
  const [maskPreview, setMaskPreview] = useState<MaskBox[] | null>(null);
  const maskPreviewRef = useRef<MaskBox[] | null>(null);
  // 预览确认时的落地类型：mosaic=自动打码；dewarp=自动去水印（OCR 重复文字→inpaint）
  const [maskApplyMode, setMaskApplyMode] = useState<"mosaic" | "dewarp">("mosaic");
  // 贴图「预览即钉」（P1）：完成态半透明浮动预览，拖动定位松手即钉
  const [pinPreview, setPinPreview] = useState<{ x: number; y: number } | null>(null);
  const [pinPreviewUrl, setPinPreviewUrl] = useState<string | null>(null);
  const pinPreviewRef = useRef<{ x: number; y: number } | null>(null);
  const pinPreviewShownRef = useRef(false);
  const pinDragRef = useRef<{ dx: number; dy: number } | null>(null);
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
  /** OCR 代号：后台识别落地时对不上当前代号就丢弃。
   *  完成后 OCR 不再阻塞出图（见 finalizeCanvas），所以必须能作废在途的那一轮：
   *  用户在识别未完时 Esc 退回重选，旧结果落下来就会把字层画到新选区上。 */
  const ocrGenRef = useRef(0);
  const [ocrDrawerOpen, setOcrDrawerOpen] = useState(false);
  const [ocrToast, setOcrToast] = useState<string | null>(null);
  const ocrToastTimerRef = useRef<number | null>(null);
  /** toast 点击时复制的内容（null → 复制 OCR 全文；动作链结果用非空覆盖） */
  const ocrToastCopyRef = useRef<string | null>(null);
  /** V6.19 编辑器目标文件（打开时显示"插入到当前文档"） */
  const [editorTarget, setEditorTarget] = useState<string | null>(null);
  // A 方案增强：OCR 识别过程可见——"识别中…"指示 → 完成胶囊（自动滑入，6s 收起）
  /** OCR 状态。failed 与 empty 必须分开 —— 旧实现失败也设成 empty，
   *  于是"识别失败"和"图里确实没文字"在界面上完全一样（都是什么都不显示），
   *  用户无从区分，也没有重试的路（违反规则 15.3）。 */
  const [ocrStatus, setOcrStatus] = useState<
    "idle" | "running" | "done" | "empty" | "failed"
  >("idle");
  /** 识别失败的原因，挂在胶囊的 title 上，不占界面空间 */
  const [ocrErr, setOcrErr] = useState<string | null>(null);
  /** 手动重试计数：effect 的依赖里没有它就没法重跑（phase/screen/ocr 都没变） */
  const [ocrRetry, setOcrRetry] = useState(0);
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

  /* ===== 动效引导（B 方案）持久化 =====
   *  记录用户是否已用过「强力但低频」的功能（自动打码 / 取文字 / 贴图），
   *  未用过的进标注态时给按钮一次性脉冲 + 教练卡引导；用过即不再打扰。
   *  惰性初始化：只在挂载时读一次 localStorage，不在渲染里读（与 hasFixedRegion 同款）。 */
  const [usedFeatures, setUsedFeatures] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("pp_used_features") ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  });
  /** 标记某强力功能已用：写入持久化（用过了就停脉冲，不再打扰）。 */
  const notePowerUsed = useCallback((id: string) => {
    setUsedFeatures((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem("pp_used_features", JSON.stringify([...next]));
      } catch {
        /* 隐私模式 / 配额满：忽略，仅本次会话不再提示 */
      }
      return next;
    });
  }, []);
  /* 脉冲引导（B 方案）：仍未用过的「强力按钮」id 列表，用过即停。
   * 门控独立于版本号、按"功能是否真用过"判定，老用户彻底不被打扰。 */
  const POWER_TOOLS = ["automask", "ocr", "pin"] as const;
  const discoverTools = POWER_TOOLS.filter((id) => !usedFeatures.has(id));
  /* 向后端上报“本轮前端已起来”，撤销 Rust 侧的存活探针（见 screenshot.rs SHOT_READY_GEN）。
   * ❗ 必须无条件、且在任何提前 return 之前 —— 它是探针唯一的撤销信号，
   *   漏报的后果是 5 秒后一个健康的截图窗被后端误杀。上报失败补一次重试。 */
  useEffect(() => {
    let cancelled = false;
    const report = (attempt: number) => {
      invoke("screenshot_ready").catch((e) => {
        logger.warn(`上报截图窗就绪失败（第 ${attempt} 次）`, e);
        if (!cancelled && attempt < 2) setTimeout(() => report(attempt + 1), 300);
      });
    };
    report(1);
    return () => {
      cancelled = true;
    };
  }, []);
  // V6 诊断：截屏失败可见化（不再静默关窗，用户能看到原因）
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** 选区是否已确定。true 时 hover 吸附不再改动选区。
   *  置位时机：拖选有效 / 选区内原地单击 / 双击 / 平移结束 / 固定区域恢复；
   *  清位：选区外原地点击（视为误点）、右键回选区态、resetShot。
   *  ⚠️ 原名 draggedRef（“拖过没”）名不副实——它管的一直是“选区是否已确定”，
   *  加了固定区域恢复之后更不符，故改名。 */
  const selFixedRef = useRef(false);
  const snapTsRef = useRef(0);
  // V6.19 磁吸参照：最后一次 hover 命中的窗口（拖选/缩放时边缘对齐用）
  const lastSnapRef = useRef<SnapTargets | null>(null);
  // Tier3 双层轮廓：外层淡蓝窗口边界（物理像素局部坐标）；与选区框（ctrl）同坐标系。
  // 仅当 ctrl 明显小于 win（<97%）时渲染，否则 solo 只显选区框。
  const [snapWin, setSnapWin] = useState<Rect | null>(null);
  // 常驻提示条：仅框选前（select 态）展示，首次使用展示数次后自动淡出（持久化计数，手动 × 可提前关闭）。
  // 降噪（方案 A）：次数 5→3、时长 9s→6s；annotate 态已有教练卡/NEW 引导，不再重复弹提示条。
  const HINT_MAX_SHOWS = 3;
  const HINT_AUTO_FADE_MS = 6000;
  const [hintVisible, setHintVisible] = useState(false);
  const [hintFading, setHintFading] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("pp_snap_hint_dismissed") === "1") return;
    const n = Number(localStorage.getItem("pp_snap_hint_count") || "0");
    if (n < HINT_MAX_SHOWS) {
      setHintVisible(true);
      localStorage.setItem("pp_snap_hint_count", String(n + 1));
      const t = setTimeout(() => setHintFading(true), HINT_AUTO_FADE_MS);
      return () => clearTimeout(t);
    }
  }, []);
  const closeHint = () => {
    setHintFading(true);
    localStorage.setItem("pp_snap_hint_dismissed", "1");
  };
  // Tier3 键盘遍历：snapWin 的镜像 ref（keydown 处理里取不到最新 state），以及控件清单缓存。
  const snapWinRef = useRef<Rect | null>(null);
  const kbCtrlsRef = useRef<Rect[]>([]); // 当前窗口内控件（局部坐标）
  const kbWinRectRef = useRef<Rect | null>(null); // 缓存清单对应的窗口（局部坐标）
  const kbIndexRef = useRef(0); // 当前遍历到的控件下标
  const kbActiveRef = useRef(false); // 是否处于键盘遍历态（鼠标移动 / Esc 可退出）

  // snapWin state → ref（keydown 处理拿不到最新 state）
  useEffect(() => {
    snapWinRef.current = snapWin;
  }, [snapWin]);

  // 枚举当前窗口控件清单（局部坐标），缓存到 refs；返回是否拿到非空清单
  const loadControls = useCallback(
    async (win: Rect): Promise<boolean> => {
      if (!screen) return false;
      const cx = win.x + win.w / 2;
      const cy = win.y + win.h / 2;
      const [sx, sy] = toScreenPt(screen, cx, cy);
      try {
        const res = await invoke<ControlList | null>("enum_controls", {
          x: Math.round(sx),
          y: Math.round(sy),
        });
        if (!res || res.ctrls.length === 0) {
          kbCtrlsRef.current = [];
          kbWinRectRef.current = null;
          return false;
        }
        const localWin = toLocalRect(screen, res.win);
        const localCtrls = res.ctrls.map((c) => toLocalRect(screen, c));
        kbWinRectRef.current = localWin;
        // 按视觉阅读顺序重排：Tab 不再按 UIA 树序乱跳，而是「从左到右、从上到下」
        kbCtrlsRef.current = sortControlsVisual(localCtrls);
        // 初始下标：离当前选区 / 窗口中心最近的控件
        const from = selRef.current ?? localWin;
        let best = 0;
        let bestD = Infinity;
        localCtrls.forEach((c, i) => {
          const d = Math.hypot(
            c.x + c.w / 2 - (from.x + from.w / 2),
            c.y + c.h / 2 - (from.y + from.h / 2),
          );
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        kbIndexRef.current = best;
        return true;
      } catch {
        return false;
      }
    },
    [screen],
  );

  // 把当前 kb 下标对应的控件设为选区 + 外层窗口轮廓
  const applyKbSelection = useCallback(() => {
    const t = kbCtrlsRef.current[kbIndexRef.current];
    if (!t || !screen) return;
    const win = kbWinRectRef.current;
    lastSnapRef.current = {
      win: win ? toScreenRect(screen, win) : { x: 0, y: 0, w: screen.width, h: screen.height },
      ctrl: toScreenRect(screen, t),
    };
    setSel(t);
    if (win) setSnapWin(win);
  }, [screen]);
  // 拖选磁吸参照：会话开始枚举一次的所有可见窗口矩形（底图局部坐标），用于吸邻窗边缘
  const winRectsRef = useRef<Rect[]>([]);
  const abortLongRef = useRef(false);
  /** 停止并出图：与 abort 语义不同 —— 用已拼的内容出图。
   *  两者都只能由状态小窗触发：长截图期间截图窗被 hide()，收不到任何按键。 */
  const stopLongRef = useRef(false);
  /** 长截图期间 Esc 的连按次数（逃生舱用，每轮长截图开始时归零） */
  const escBurstRef = useRef(0);
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
  // 默认值与 draw.ts / tools.tsx 的中档保持一致。
  // 旧值 12 / 10 在 2.5K 屏上看着粗（实测反馈）。
  const [mosaicStrength, setMosaicStrength] = useState(8);
  const [blurStrength, setBlurStrength] = useState(6);
  /** 去水印边缘羽化半径（物理像素），复用 strength 语义；默认中档 10。 */
  const [dewarpStrength, setDewarpStrength] = useState(10);
  /** 去水印模式：平铺·自动（点画布整屏检测）/ 手动（拖拽选区局部）。默认平铺（企业微信主场景）。 */
  const [dewarpMode, setDewarpMode] = useState<"manual" | "tile">("tile");
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
  /** 同 copyImageRef：这几个函数都定义在快捷键 effect **之后**，
   *  直接进闭包会拿到陈旧的 busy / resultPath，写进依赖数组又是 TDZ。
   *  所以统一走 ref —— 每次渲染刷新一份最新的。 */
  const openAiRef = useRef<() => void>(() => {});
  const saveExitRef = useRef<() => void>(() => {});
  const insertEditorRef = useRef<() => void>(() => {});
  // V2：底图 Image（马赛克采样 + 合成 + 放大镜共用），物理像素
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  /** 始终指向最新的 redraw。底图加载完要补一次重绘（把占位棋盘换成真马赛克），
   *  但那个 effect 不能把 redraw 写进依赖 —— redraw 随 annotations 变，会让它反复重跑。 */
  const redrawRef = useRef<() => void>(() => {});
  // 放大镜 / 取色：唯一一处直接操作 DOM 的交互（拖选高频，走 setState 会掉帧）。
  // 已抽到 hooks/useMagnifier —— 它零 useState，只吃 dpr 与底图。
  const { magRef, magCanvasRef, magInfoRef, updateMag, hideMag, copyHex } = useMagnifier({
    dpr,
    baseImgRef,
  });

  /* 拖选状态（select 态，物理坐标，相对虚拟屏幕原点） */
  const dragRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  // 给 window 级兜底监听用的“最新 finalize 实现”引用（避免 effect 反复重订）
  const finalizeSelectDragRef = useRef<() => void>(() => {});

  /* V6.19：清空 OCR 状态（重选/重截时重置，防旧选区行框错位 + 提前识别不触发） */
  const clearOcrState = useCallback(() => {
    setOcr(null);
    setOcrStatus("idle");
    setOcrErr(null);
    setOcrDrawerOpen(false);
    setOcrToast(null);
    // 一并清掉选字交互态：避免残留的 window mouseup 在重新识别/退出后误复制字。
    // ocrDragRef 置空后，onOcrSelectUp/Move 会因 s===null 直接 return（已无副作用）。
    setOcrSel(new Set());
    setOcrDrag(null);
    setOcrBarOpen(false);
    ocrDragRef.current = null;
    preloadOcrStartedRef.current = false;
    // 作废所有在途的后台识别（finalizeCanvas 里的那轮不阻塞，可能还在跑）。
    ocrGenRef.current++;
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
    // 预览态/浮层（固定区域/自动打码/贴图）一并清空，避免残留跨次截图
    setFixedPreview(false);
    fixedPreviewRef.current = false;
    setMaskPreview(null);
    maskPreviewRef.current = null;
    setPinPreview(null);
    pinPreviewRef.current = null;
    setPinPreviewUrl(null);
    pinPreviewShownRef.current = false;
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
      // 枚举可见窗口矩形，供拖选时吸邻窗边缘（窗口在会话内不动，取一次即可）
      void invoke<SnapRect[]>("enum_window_rects")
        .then((list) => {
          if (disposed) return;
          winRectsRef.current = (list ?? []).map((r) => toLocalRect(s, r));
        })
        .catch(() => {
          /* 枚举失败则无邻窗磁吸，不影响主流程 */
        });
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
            // 预览即默认（P1）：固定区域不再静默进标注，改为虚线紫框预览。
            // 用户单击采纳 / 拖拽改区域 / Esc 回吸附——避免"选区被锁死"的困惑。
            // 旧实现直接 setPhase("annotate") 会让用户以为选区不可改。
            fixedPreviewRef.current = true;
            setFixedPreview(true);
          }
        }
      } catch {
        /* 本地存储损坏时忽略 */
      }
    };

    // V6 启动提速：优先取后端并行预截屏的结果（热键回调里已经开始截屏）。
    //
    // ⚠️ 必须**等一下**，不能一次 take 不中就自截：
    // 复用窗口时 show() 几乎瞬时、emit refresh 立刻到达，而预截屏（BitBlt + JPEG
    // + base64，两三百毫秒）才刚开始 —— 第一次 take 必然 miss。立刻自截的后果是
    // 一次开窗把全屏截两遍（dev 日志里能看到两条连着的"截屏成功"），
    // 多出的那张还会残留在缓存里被下次误用。等它反而更快 —— 它已经先跑了一段。
    const capture = async () => {
      try {
        const deadline = Date.now() + PENDING_WAIT_MS;
        while (Date.now() < deadline) {
          const s = await invoke<ScreenInfo | null>("take_pending_shot_capture");
          if (disposed) return;
          if (s) {
            applyScreen(s);
            return;
          }
          await sleep(PENDING_POLL_MS);
        }
        // 等超时（预截屏失败或特别慢）才自己截一遍
        const s = await invoke<ScreenInfo>("capture_screen");
        if (!disposed) applyScreen(s);
      } catch (e) {
        logger.error("截图失败", e);
        // 不静默关窗：显示错误原因，用户可 Esc 关闭或重试
        if (!disposed) setCaptureError(String(e));
      }
    };

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

  /** 统一的出口反馈。成功与失败走同一个通道，避免下一个出口被写出来时又漏提示（规则 11.1）。
   *  定义得靠前：底图预加载 effect 失败时要用它报错。 */
  const showToast = useCallback((text: string, ok = false) => {
    setShotToast({ text, ok });
    if (shotToastTimerRef.current) window.clearTimeout(shotToastTimerRef.current);
    shotToastTimerRef.current = window.setTimeout(() => setShotToast(null), 3000);
  }, []);

  /* 底图 Image 预加载（马赛克采样 / 合成 / 放大镜共用）。
   *
   * 旧实现是裸的 `void loadImage(...).then(...)`：一旦 reject，baseImgRef 永远是 null，
   * 而马赛克/模糊会静默退化成占位块 —— 用户只会觉得"这功能就是个格子"。
   * 现在：失败重试 3 次（递增退避），成功后补一次重绘把占位块换成真效果，
   * 彻底失败则明确告知用户（规则 15.3）。 */
  useEffect(() => {
    if (!screen) return;
    let cancelled = false;
    let tries = 0;
    const load = () => {
      loadImage(screen.dataUrl)
        .then((img) => {
          if (cancelled) return;
          baseImgRef.current = img;
          redrawRef.current(); // 底图到位 → 已画的占位棋盘立即变成真马赛克/模糊
        })
        .catch((e) => {
          if (cancelled) return;
          tries += 1;
          logger.warn(`底图预加载失败（第 ${tries} 次）`, e);
          if (tries < 3) {
            window.setTimeout(load, 200 * tries);
          } else {
            logger.error("底图预加载连续失败，马赛克/模糊无法采样");
            showToast("底图加载失败 · 马赛克与模糊暂不可用");
          }
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [screen, showToast]);

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
    // 高亮必须先画（multiply 会和已画的标注相乘，见 inDrawOrder 的注释）。
    // 草稿一起参与排序：正在拖的那一笔本身可能就是高亮。
    // 正在编辑的文字（textDraft.id）从画布隐藏：避免原文透出输入框半透明底（微信同款）。
    const editId = textDraft?.id ?? null;
    const visible = editId != null ? annotations.filter((a) => a.id !== editId) : annotations;
    const toDraw = draftRef.current ? [...visible, draftRef.current] : visible;
    for (const a of inDrawOrder(toDraw)) drawAnnot(ctx, a, base, ox, oy);
    // 选中框已移到 DOM 层（.annot-sel-box，见 JSX）：
    // canvas 里画会与元素重叠、看起来像"画布底色"（用户反馈），
    // 且 canvas 无法做半透明填充不遮元素的选中态。此处不再绘制。
    // → 所以依赖里也不再需要 selectedIds（选中态变化不影响画布内容）。
  }, [annotations, textDraft]);
  // 供底图加载完成后调用（见 baseImgRef 声明处注释）
  redrawRef.current = redraw;

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
      setSel(applyMagnet(clamped, [...winRectsRef.current, ...(lastSnapRef.current ? [lastSnapRef.current.ctrl] : [])], sc.width, sc.height));
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

  /** 退回选区态（不关窗）。Esc 与右键两个"后退一步"入口共用。
   *
   *  ⚠️ 工具栏的"✕ 取消"不走这里 —— 它写着"取消"，用户读到的就是"取消这次截图"，
   *  所以直接关窗（微信截图同款）。Esc / 右键才是两级后退。
   *
   *  收口到一处还修了一个真 bug：Esc 分支原本是另一份手写实现，漏了
   *  selFixedRef 重置 —— 按 Esc 回到选区态后 hover 吸附不恢复，选区被死死固定住（规则 11.1）。 */
  const cancelAnnot = useCallback(() => {
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    setTextDraft(null);
    setSelectedIds([]);
    setMaskPreview(null); // 退出标注时丢弃未确认的打码预览
    maskPreviewRef.current = null;
    clearOcrState();
    selFixedRef.current = false; // 解除固定 → hover 吸附恢复，可以重新挑窗口
    setPhase("select");
  }, [clearOcrState]);

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
        // ⚠️ 长截图期间本窗已被 hide()，这条分支实际收不到事件。
        // 真正能中止的入口是状态小窗的"放弃"按钮（走 LONGSHOT_CONTROL 事件）。
        // 保留它只为覆盖"状态窗没开成、截图窗又提前恢复"这种异常路径。
        // 两级取消（P4）：预览态优先回退，再 Esc 才整体退出
        if (fixedPreviewRef.current) {
          setFixedPreview(false);
          fixedPreviewRef.current = false;
          setSel(null);
          selFixedRef.current = false; // 解除固定 → hover 吸附恢复
          return;
        }
        if (maskPreviewRef.current) {
          setMaskPreview(null);
          maskPreviewRef.current = null;
          return;
        }
        if (pinPreviewRef.current) {
          setPinPreview(null);
          pinPreviewRef.current = null;
          return;
        }
        // ⑤ 拖选字级进行中：先清选区/复制条，再 Esc 才做其它（两级取消）。
        if (ocrBarOpenRef.current || ocrSelRef.current.size > 0) {
          setOcrBarOpen(false);
          setOcrSel(new Set());
          setOcrDrag(null);
          return;
        }
        if (longShotRef.current) {
          abortLongRef.current = true;
          // 逃生舱：连按 3 次 Esc 还没退出，说明 longShot 状态可能卡住了
          // （或循环读不到标志位），直接强关窗，不能把人困在截图里。
          escBurstRef.current += 1;
          if (escBurstRef.current >= 3) {
            logger.warn("长截图中连续 3 次 Esc，强制关闭截图窗");
            void invoke("close_screenshot_window");
          }
          return;
        }
        // Tier3 键盘遍历态：Esc 先退出遍历回到 hover 吸附（两级取消），再 Esc 才关窗
        if (kbActiveRef.current) {
          kbActiveRef.current = false;
          return;
        }
        if (p === "annotate") {
          // 编辑态 Esc = 放弃标注回到选区（两级取消：编辑 → 选区 → 关闭）
          cancelAnnot();
          return;
        }
        void invoke("close_screenshot_window");
        return;
      }
      if (p === "select" && longShotRef.current) return; // 长截图中忽略其余快捷键
      if (p === "select") {
        // Tier3 键盘遍历：Tab / Shift+Tab 线性遍历、方向键定向遍历（仅未手动画选区时）。
        // 与「方向键微调选区」互斥：遍历态优先把方向键当成「跳到下一个控件」。
        const isTab = e.key === "Tab";
        const isArrow = e.key.startsWith("Arrow");
        if (isTab || isArrow) {
          const win = snapWinRef.current;
          if (!win) return; // 桌面空白：无控件可遍历，交给下方默认逻辑
          // 进入 / 维持键盘遍历态；窗口变化（或首次）则重新枚举控件清单
          const kw = kbWinRectRef.current;
          const winChanged =
            !kbActiveRef.current ||
            !kw ||
            Math.abs(kw.x - win.x) > 2 ||
            Math.abs(kw.y - win.y) > 2 ||
            Math.abs(kw.w - win.w) > 2 ||
            Math.abs(kw.h - win.h) > 2;
          if (winChanged) {
            e.preventDefault();
            kbActiveRef.current = false;
            void (async () => {
              const ok = await loadControls(win);
              if (!ok) {
                kbActiveRef.current = false;
                return;
              }
              kbActiveRef.current = true;
              applyKbSelection();
            })();
            return;
          }
          e.preventDefault();
          if (isTab) {
            const n = kbCtrlsRef.current.length;
            if (n === 0) return;
            let i = kbIndexRef.current + (e.shiftKey ? -1 : 1);
            i = ((i % n) + n) % n;
            kbIndexRef.current = i;
          } else {
            const from = selRef.current ?? win;
            const dir = e.key.slice(5).toLowerCase() as Dir; // "ArrowRight" → "right"
            const next = nearestInDirection(kbCtrlsRef.current, from, dir);
            if (!next) return;
            const idx = kbCtrlsRef.current.indexOf(next);
            if (idx >= 0) kbIndexRef.current = idx;
          }
          kbActiveRef.current = true;
          applyKbSelection();
          return;
        }
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
        // T：直接复制全文，不开抽屉——熟练用户一步到位（规则 17.2）。
        // ❗ 三个守卫都不能掉：
        //   ① !textDraft：文字工具输入框开着时，"t" 是在打字；
        //   ② 无修饰键：Ctrl+T / Alt+T 不归我们管；
        //   ③ 工具快捷键是 1-9/0，T 未被占用（改工具表时要回来核这一条）。
        if (
          (e.key === "t" || e.key === "T") &&
          !e.ctrlKey && !e.metaKey && !e.altKey &&
          !textDraft
        ) {
          e.preventDefault();
          if (ocr?.fullText?.trim()) {
            void copyText(ocr.fullText);
            showToast(`已复制 ${ocr.lines.length} 行文字`, true);
          } else {
            // 不能静默（规则 15.3）：按了什么都没发生比报错更让人摸不着
            showToast(
              ocrStatus === "running" ? "正在识别文字，稍等一下" : "图中未识别到文字",
            );
          }
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
        // 按 key 查表而不是 TOOLS[Number(e.key)-1]：一重排工具，下标就跟着动、
        // 按键却被用户记住，不能跟着错位——旧实现会静默按错工具（规则 15.3）。
        const toolByKey = TOOL_BY_KEY[e.key];
        if (toolByKey) setTool(toolByKey);
      }

      /* result 态。
       *
       * ⚠️ 这个分支以前**完全不存在** —— onKey 只处理 select / annotate。
       * 而出口面板上一直印着 Ctrl+C / Ctrl+S / Ctrl+Enter 三个快捷键，
       * 也就是说界面写着快捷键、按了什么都不发生（违反规则 15.3）。
       *
       * 全部走 ref：本 effect 的依赖盖不全 busy / resultPath / editorTarget，
       * 直接调闭包里那份会拿到陈旧值（annotate 态的 Enter 已经踩过并用 ref 解了）。 */
      if (p === "result") {
        if (e.key === "Escape") {
          e.preventDefault();
          // 规则 17.6 两级取消：先退回标注态（还能改图），再按才是关窗。
          // 关窗由 annotate 分支的 Esc 处理，这里只退一步。
          setPhase("annotate");
          return;
        }
        if (onButton) return; // 焦点在面板按钮上：让它自己的 click 生效
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          // 仅编辑器打开时生效——与面板里那一行的可见条件保持一致，
          // 否则就是又一个"印着快捷键但没有对应出口"的假承诺。
          if (!editorTarget) return;
          e.preventDefault();
          insertEditorRef.current();
          return;
        }
        if (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c")) {
          e.preventDefault();
          copyImageRef.current();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveExitRef.current();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // ocr / ocrStatus / textDraft 必须在依赖里：闭包不重建就会捕获到旧值。
    // ① 没有 textDraft：文字输入框开着时闭包里它永远是 null，打字按 T 会被当成
    //    "复制全文"、按方向键会去挪选区（后者是旧有问题，顺手一并修）。
    // ② 没有 ocr：用户一笔未画时 annotations 不变，闭包不重建，Ctrl+R / T 都拿不到识别结果。
    // ③ 没有 editorTarget：result 分支的 Ctrl+Enter 用它做可用性判断，
    // 闭包不重建就会在编辑器刚打开时仍然认为"没有文档可插入"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    annotations, undoStack, redoStack, aiOpen, chainOpen, selectedIds,
    ocr, ocrStatus, textDraft, editorTarget,
  ]);

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

  /** 当前线宽（物理像素）。新建标注时写进 annotation.width，
   *  既有标注保持各自当时的线宽不受影响。 */
  const lineW = WIDTHS.find((w) => w.id === widthId)?.w ?? 3;

  /** 在光标层上画橡皮范围圈。传 null 表示清掉（工具切换 / 鼠标移出选区）。 */
  const drawEraserCursor = useCallback(
    (px: number | null, py: number | null) => {
      const cv = eraserCurRef.current;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (px === null || py === null) return;
      const r = lineW * ERASER_RADIUS_SCALE;
      // 双色描边：白 + 半透明黑，浅底深底都看得见（单色圈在同色背景上会消失）
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.arc(px, py, r + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
    },
    [lineW],
  );

  /* 工具一切走就清掉圈，否则切到别的工具后那个圈会一直留在屏幕上。
   * 依赖里带 drawEraserCursor：它随 lineW 变，粗细改了要立刻重画成新半径。 */
  useEffect(() => {
    if (tool !== "eraser") drawEraserCursor(null, null);
  }, [tool, drawEraserCursor]);

  /** 当前字号，**物理像素**（= CSS 字号 × dpr）。
   *
   *  这个换算是修“文字工具看不到任何东西”的关键：TEXT_SIZES 里存的是 CSS 像素，
   *  而 canvas 的 bitmap 是物理像素、draw.ts 全程按物理像素画。
   *  旧实现把 18 直接当物理像素用，于是 dpr=2.5 的屏上只有 7.2 CSS 像素。 */
  const fontCss = TEXT_SIZES.find((t) => t.id === textSizeId)?.css ?? 20;
  const fontPx = Math.round(fontCss * dpr);
  /** 橡皮半径（物理像素），跟线宽档位走 */
  const eraserRadius = lineW * ERASER_RADIUS_SCALE;
  /** 当前工具的遮罩形状；非遮罩类工具无意义 */
  const maskShape = maskShapes[tool] ?? "brush";

  // 长截图状态小窗的控制回传。长截图期间本窗被 hide()，收不到任何输入事件，
  // 所以"停止/放弃"只能走 IPC 事件 —— 这也正是旧的 Esc 中止一直是死功能的原因。
  // 事件链路与窗口可见性无关（长截图循环本身就在隐藏期间跑并持续 invoke 后端）。
  useEffect(() => {
    const un = listen<LongShotControl>(LONGSHOT_CONTROL, (e) => {
      if (!longShotRef.current) return; // 不在长截图中的残留事件直接忽略
      if (e.payload === "abort") abortLongRef.current = true;
      else if (e.payload === "stop") stopLongRef.current = true;
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 主栏尺寸实测。用 ResizeObserver 而不是每次渲染量：后者要么漏测（加了依赖数组），
  // 要么形成 setState 循环（不加依赖数组）。updater 返回 prev 时 React 会 bail out，不重渲染。
  // useLayoutEffect：要在浏览器绘制前把位置改对，否则能看到一帧跳动。
  useLayoutEffect(() => {
    const observe = (
      el: HTMLDivElement | null,
      set: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>,
    ) => {
      if (!el) return null;
      const ro = new ResizeObserver(() => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0) return;
        set((prev) =>
          Math.abs(r.width - prev.w) > 0.5 || Math.abs(r.height - prev.h) > 0.5
            ? { w: r.width, h: r.height }
            : prev,
        );
      });
      ro.observe(el);
      return ro;
    };
    const roTb = observe(tbRef.current, setTbSize);
    const roAct = observe(actRef.current, setActSize);
    const roPill = observe(pillRef.current, setPillSize);
    return () => {
      roTb?.disconnect();
      roAct?.disconnect();
      roPill?.disconnect();
    };
  }, [phase, sel]);

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

  /** 把「操作前的标注快照」压进撤销栈并清空重做栈，返回那份快照。
   *
   *  收口（规则 11.1）：commitAnnot / applyMasks / runDewatermarkTile / 文字编辑 四处
   *  原本各写一遍同样的三行。commitAnnot 的注释自己都写着「这里是漏网的一处」——
   *  改一处漏三处的后果就是某类操作 Ctrl+Z 退不回去。
   *
   *  ⚠️ 不能写成 setAnnotations(prev => { setUndoStack(...); return ...; })：
   *  StrictMode 下 updater 会被调用两次，嵌套的 setUndoStack 跟着执行两次，
   *  同一份快照被压进 undo 栈两份 → Ctrl+Z 要按两次才退一格。所以这里用 ref 取最新值。 */
  const pushUndoSnapshot = useCallback((): Annotation[] => {
    const prev = annotationsRef.current;
    setUndoStack((u) => [...u, prev]);
    setRedoStack([]);
    return prev;
  }, []);

  /* ===== 提交一个标注元素（入栈） ===== */
  const commitAnnot = useCallback((a: Annotation) => {
    const prev = pushUndoSnapshot();
    setAnnotations([...prev, a]);
  }, [pushUndoSnapshot]);

  /* V5：原地更新标注元素（移动/缩放用，不上 undo——由操作结束统一快照） */
  const updateAnnot = useCallback((id: number, patch: Partial<Annotation>) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  /* ===== 自动打码（P0）：已抽到 hooks/useAutoMask ===== */
  // 行为型 hook：maskPreview 状态留在本组件（JSX 渲染预览框、resetShot 要清它），
  // 撤销栈由注入的 pushUndoSnapshot 统一处理。
  const { runAutoMask, toggleMaskBox, applyMasks, runAutoDewarp, applyDewarpMasks } = useAutoMask({
    ocr,
    setOcr,
    screen,
    selRef,
    busy,
    mosaicStrength,
    setOcrStatus,
    maskPreviewRef,
    setMaskPreview,
    setAnnotations,
    showToast,
    pushUndoSnapshot,
  });

  /** 工具栏选工具：自动打码是动作型按钮，拦截后执行打码、不切换绘制工具。 */
  const onSelectTool = useCallback(
    (id: ToolId) => {
      if (id === "automask") {
        notePowerUsed("automask"); // B 方案：用过即停脉冲/教练卡
        // ❌ 必须复位：maskApplyMode 是与 maskPreview 平行的 state，且只有这里和
        // autodewarp 两个入口会写。若用过一次「自动去水印」后直接用「自动打码」，
        // 模式还停在 "dewarp"，确认条会把隐私框派发给 applyDewarpMasks——
        // 对手机号/身份证做的是还原而不是遮蔽。两个入口都显式设模式才闭环。
        setMaskApplyMode("mosaic");
        void runAutoMask();
        return;
      }
      if (id === "autodewarp") {
        setMaskApplyMode("dewarp");
        void runAutoDewarp();
        return;
      }
      setTool(id);
    },
    [runAutoMask, runAutoDewarp, notePowerUsed],
  );


  /* 去水印·平铺模式：检测整屏平铺周期 → 批量生成 dewarp 单元格 annotation（整批一次 undo）。
   * 与自动打码同思路：动作型，点画布即执行（onAnnotMouseDown 拦截），整批一次入撤销栈。 */
  const runDewatermarkTile = useCallback(async () => {
    const base = baseImgRef.current;
    const r = selRef.current;
    if (!base || !r) {
      showToast("底图未就绪，请稍候再试", false);
      return;
    }
    const bw = Math.max(1, Math.round(r.w));
    const bh = Math.max(1, Math.round(r.h));
    // ❌ 三段式检测（轴对齐估计 → 斜率扫描 → 全分辨率中值叠瓦，最多各一轮）全部同步
    // 跑在 UI 线程，大选区实测可达数秒——必须先置忙碌态并让出一帧再算，
    // 否则用户看到的就是「点了没反应」；finally 兜底复位，异常路径不卡忙碌。
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50)); // 给忙碌态一次上屏机会
      const cv = document.createElement("canvas");
      cv.width = bw;
      cv.height = bh;
      const cctx = cv.getContext("2d");
      if (!cctx) {
        showToast("画布不可用，无法去水印", false);
        return;
      }
      cctx.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, bw, bh);
      const id = cctx.getImageData(0, 0, bw, bh);
      /* 要重新标定阈值时，在这里插一行把真实频谱扫进剪贴板，必须放在检测 **之前**：
       *   void invoke("copy_only", { text: probeSpectrum(id.data, bw, bh) });
       * 工具在 @/lib/screenshot/dewarpProbe，平时不接入主流程：它要跑四轮 FFT，
       * 848×939 选区实测 ~600ms，不能挂在每次点击上。 */
      // 直接尝试整屏去水印（中值叠瓦 + FFT 兜底，自带 clip-guard：产生严重伪影会安全恢复原图）。
      // 不再前置 hasPeriodicWatermark 硬拒——稀疏斜向文字水印频域峰弱、旧检测会漏，
      // 导致「点了没反应」。交给真实算法跑一遍，用返回值决定反馈（结果会被 draw.ts 的
      // _dewarpCache 复用，不重复计算）。
      const ok = removeTiledWatermarkRegion(id.data, bw, bh, {
        tiled: true,
        feather: dewarpStrength,
        radius: 8,
      });
      if (!ok) {
        showToast("平铺水印已尝试但未明显减弱，建议用「文字·自动」或手动框选", false);
        return;
      }
      const feather = dewarpStrength;
      // 整屏平铺去水印 = 单个整选区 annotation。频域提取在 draw.ts 内整块完成。
      // 整批一次 undo、一次渲染。
      const el: Annotation = {
        id: nextId(),
        type: "dewarp",
        color: "",
        width: 0,
        x: 0,
        y: 0,
        x2: bw,
        y2: bh,
        strength: feather,
        shape: "rect",
        tiled: true,
      };
      const prev = pushUndoSnapshot();
      setAnnotations([...prev, el]);
      showToast("已整屏去水印", true);
    } catch (e) {
      logger.warn("去水印平铺检测失败", e);
      showToast("去水印失败，请改用手动模式", false);
    } finally {
      setBusy(false);
    }
  }, [showToast, dewarpStrength, pushUndoSnapshot, setBusy]);

  /* V5：操作结束统一入 undo（移动/缩放/删除共用：先把操作前的快照压栈） */
  const snapshotUndo = useCallback(() => {
    const snap = moveSnapshotRef.current;
    if (!snap) return;
    moveSnapshotRef.current = null;
    setUndoStack((u) => [...u, snap]);
    setRedoStack([]);
  }, []);

  /**
   * 「拖拽型」操作收尾入 undo：状态没变就把快照丢掉，不占撤销栈。
   *
   * 为什么需要单独一个而不是直接在 snapshotUndo 里判：两类调用方的**时序不同**。
   *   - 拖拽型（移动 / 把手缩放）：快照在 **mousedown** 就存了，那时还不知道用户会不会真拖。
   *     中间的 mousemove 每次都 setAnnotations → 已经重渲染过 → 真动过时
   *     annotationsRef.current 一定是个新数组，引用比较就够用。
   *   - 立即型（橡皮擦 / Delete）：存快照、setAnnotations、snapshotUndo 在**同一个同步块**里，
   *     此时 annotationsRef 还没跟着更新（它是在 render body 里赋值的），
   *     引用必然仍等于快照 —— 在 snapshotUndo 里做等值判断会把这两条路径的撤销直接误杀。
   *
   * 不判的后果（原 bug）：点一下选中某个标注、或点一下把手就松手，都会压进一格
   * 「撤销了但画面没变化」的空操作 → Ctrl+Z 按了没反应、要连按好几次；
   * 而 snapshotUndo 里的 setRedoStack([]) 更糟 —— 仅仅点一下标注就把重做栈清空了。
   */
  const snapshotUndoIfChanged = useCallback(() => {
    if (moveSnapshotRef.current === annotationsRef.current) {
      moveSnapshotRef.current = null; // 没动过：丢弃快照
      return;
    }
    snapshotUndo();
  }, [snapshotUndo]);

  /* ===== 完成：合成 → 保存 → OCR ===== */
  /** 统一收尾：canvas 合成图 → 保存 → OCR → result 态（普通截图 / 长截图共用） */
  const finalizeCanvas = useCallback(async (out: HTMLCanvasElement) => {
    // 无损 PNG 合成（详见 canvasToDataUrl 的注释：旧的 JPEG 0.92 是“不如实际清晰”的第二代有损）。
    // toBlob 而不是 toDataURL：后者同步阻塞主线程，长图能把界面卡住好几秒
    const { path, dataUrl } = await saveResultImage(out);
    setResultPath(path);
    resultCanvasRef.current = out; // 供二维码识别（result 态 useEffect 取用）
    // ⚡ 先进结果态，再后台跑 OCR。
    // 旧顺序是 await ocrImage() 完了才 setPhase("result")，于是「完成」按下去之后
    // 结果面板要等一整轮文字识别才出现——而点「完成」要的是**图**，文字是点
    // 「取文字」时才要的（用户反馈的「点完成耗时比较高」主要就是这里）。
    // ocrStatus 本来就有 running/done/empty/failed 四态、界面已能表达「正在识别」，
    // 后台补结果对 UI 是完备的。
    setPhase("result");
    setTextDraft(null);
    // OCR：复用现有 PP-OCRv6 引擎（行级坐标相对合成图，与标注画布同坐标系）。
    // 超长图直接跳过：上万像素高的图 OCR 要跑几十秒到几分钟，而这一步在
    // 窗口恢复之前（旧顺序）就是"点了长截图一直等"的真凶之一。
    if (out.height > LONG_OCR_MAX_H) {
      logger.info(`合成图高 ${out.height}px 超过 ${LONG_OCR_MAX_H}px，跳过 OCR`);
      setOcr({ lines: [], fullText: "" });
      setOcrStatus("empty");
      showToast(`长图已跳过文字识别（高 ${out.height}px）`, true);
    } else {
      // 不 await：让结果面板先出来。gen 令牌防过期结果——用户可能在识别还在跑时
      // 就按 Esc 退回重选了，那时候落下来的旧结果会把新选区的字层画错地方。
      const gen = ++ocrGenRef.current;
      setOcrStatus("running");
      void (async () => {
        try {
          const ocrResult = await ocrImage(path);
          if (ocrGenRef.current !== gen) return;
          setOcr(ocrResult);
          setOcrStatus(ocrResult.fullText?.trim() ? "done" : "empty");
        } catch (err) {
          if (ocrGenRef.current !== gen) return;
          logger.warn("OCR 识别失败（不影响图片结果）", err);
          setOcr({ lines: [], fullText: "" });
          setOcrStatus("failed");
        }
      })();
    }
    // 贴图「预览即钉」（P1）：完成态弹出半透明浮动预览，拖动定位松手即钉（微信同款高频路径零步）。
    // 每轮截图只弹一次（pinPreviewShownRef），重选重截不会反复弹。
    if (!pinPreviewShownRef.current && selRef.current) {
      const r = selRef.current;
      // 直接除 dpr 而不用 css()：css 是每次渲染新建的箭头函数，写进依赖会让
      // finalizeCanvas 每渲染都重建（它还被长截图流程持有）。dpr 是稳定值。
      // 尺寸常量与 .pin-float 拖动时的钳位保持一致（见 PIN_FLOAT_W/H）。
      const pos = {
        x: Math.max(8, Math.min(window.innerWidth - PIN_FLOAT_W, (r.x + r.w / 2) / dpr - PIN_FLOAT_W / 2)),
        y: Math.max(8, Math.min(window.innerHeight - PIN_FLOAT_H, (r.y + r.h / 2) / dpr - PIN_FLOAT_H / 2)),
      };
      pinPreviewRef.current = pos;
      setPinPreview(pos);
      // 直接用 saveResultImage 已经编码好的那份，**零额外开销**。
      // 旧写法又调了一次 out.toDataURL("image/png")：那是同步全尺寸 PNG 编码，
      // 而上面 canvasToDataUrl 用 toBlob 正是为了避开它（自己的注释就写着
      // “后者同步阻塞主线程，长图能把界面卡住好几秒”）——等于又把它请回来了。
      setPinPreviewUrl(dataUrl);
      pinPreviewShownRef.current = true;
    }
  }, [showToast, dpr]);

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

  /** 合成标注结果到新 canvas（不落盘）。finish / copyImage / ensureResultPath 共用。
   *
   *  底图复用 `baseImgRef`（底图预加载 effect 已把当前 dataUrl 解码好的 Image 存这里，
   *  马赛克/合成/放大镜共用同一份，避免完成/保存/贴图每次重复解码 4K PNG ~200ms）。
   *  返回的 canvas 像素 = 最终结果图，可直接 getImageData 直传后端复制。 */
  const renderResultCanvas = useCallback(async (): Promise<HTMLCanvasElement> => {
    const s = screen;
    const r = selRef.current;
    if (!s || !r) throw new Error("缺少选区或底图");
    if (!baseImgRef.current) {
      // 预加载 effect 尚未就绪（重试中）的兜底：自己解码一次
      baseImgRef.current = await loadImage(s.dataUrl);
    }
    const img = baseImgRef.current;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(r.w));
    out.height = Math.max(1, Math.round(r.h));
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("canvas 2d 不可用");
    ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    // 与预览用同一个排序（否则会出现“预览看着对、导出的图不对”）
    for (const a of inDrawOrder(annotations)) drawAnnot(ctx, a, img, r.x, r.y);
    return out;
  }, [screen, annotations]);

  /** 合成标注结果并落盘（幂等：已有 resultPath 直接返回）。finish（进面板）与
   *  自动链完成路径共用，避免标注态复制时无图可拷。 */
  const ensureResultPath = useCallback(async (): Promise<string> => {
    if (resultPath) return resultPath;
    const out = await renderResultCanvas();
    const { path } = await saveResultImage(out);
    resultCanvasRef.current = out;
    setResultPath(path);
    return path;
  }, [resultPath, renderResultCanvas]);

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
      showToast(`图片合成失败：${errText(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureResultPath, ocr, showToast]);

  /** 恢复截图窗 + 关状态窗 + 释放全局 Esc。幂等，可重复调用。
   *
   *  三个动作绑在一起是故意的 —— 它们必须同时发生，漏一个就会留下
   *  "状态窗还在 / Esc 被占 / 截图窗不见了"这类半死不活的状态。 */
  // 长截图整条流程（386 行）已抽到 hooks/useLongShot。它是行为型 hook：
  // 状态仍在本组件（上面那 12 个 state/ref），因为快捷键 / 预览层拖拽 / JSX 都要读写，
  // 且它们的使用点比这里靠前 —— 搬进 hook 会 TDZ。
  const { startLongShot } = useLongShot({
    screen,
    selRef,
    longShot,
    setLongShot,
    busy,
    setBusy,
    showToast,
    finalizeCanvas,
    abortLongRef,
    stopLongRef,
    escBurstRef,
  });

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
      // 规则 15.3：失败不静默。这里**不关窗** —— 窗关了 toast 就没地方显示，
      // 用户只看到"点了一下什么都没发生"（与 runExit 的失败处理同款）。
      logger.error("插入编辑器失败", e);
      showToast(`插入文档失败：${errText(e)}`);
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
      // 配置预查（同步区 await）：决定走哪条路径——自动链是前端变换，窗口销毁即中断，
      // 配置了链必须等它跑完再关窗（此时必须落盘拿 path 供 OCR/入库）
      let autoChainId: string | null = null;
      try {
        autoChainId = await invoke<string | null>("get_auto_chain_after_screenshot");
      } catch {
        /* 查询失败按无链处理 */
      }
      if (autoChainId) {
        // 有自动链：慢路径（需要文字，等链完成再关窗）——合成落盘 → OCR → 跑链 → 入库
        const path = await ensureResultPath();
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
        // 无自动链：亚秒快路径——RGBA 直传后端（复制 + 落盘 + 入库 + 补 OCR 一条龙），立即关窗。
        // 不再前端同步编码 PNG（4K toBlob 0.5~2s 阻塞主线程），复制 ~150ms 完成即关；
        // 落盘/入库由后端后台任务执行（"先见卡后补字"逻辑迁到后端，见 finish_screenshot_rgba）。
        //
        // 防"完成时画面闪"的取舍：完成路径保持"先合成再关窗"（合成/取像素是主线程同步重活，
        // 窗口仍显示时 WebView 合成器可能闪一帧）。"单击确定闪一下"的真正根因在 select 态
        // displaySel（mousedown 0×0 草稿导致蒙版跳变），已在那里收口修复，勿在此处画蛇添足。
        // 点击完成立即隐藏窗口（感知零延迟）：合成/取像素是主线程重活，窗口还显示时
        // 用户会看到"点了完成画面还停 ~200ms"。隐藏后复制由后端后台执行，
        // 失败走主窗口 toast（下方 catch 恢复显示 + 报错兜底）。
        await invoke("hide_screenshot_window").catch(() => undefined);
        // 结果态（含长截图）：resultPath 已是落盘的最终图（长截图=拼接长图）。直接让后端
        // 从文件路径复制 + 入库，**完全绕开 canvas**：① 物理路径 WebView2 拒绝直接加载；
        // ② 转 asset URL 加载后又会污染 canvas（getImageData 报跨域）。后端
        // `copy_image_only` 读文件复制、`insert_screenshot_to_history` 按文件入库（与
        // saveImageTo 对称）。注意 copy_image_only 会设 paste_suppress 抑制剪贴板监听，
        // 必须显式入库，否则复制了却又不进历史（即最初那个 bug）。
        if (resultPath) {
          await invoke("copy_image_only", { imagePath: resultPath });
          void invoke("insert_screenshot_to_history", {
            imagePath: resultPath,
            ocrText: ocr?.fullText?.trim() || null,
          }).catch((e) => logger.warn("截图复制后入库失败（不影响复制）", e));
          await sleep(150);
          close();
          return;
        }
        // 标注态（resultPath 为 null）：按底图 + 选区 + 注解实时合成，RGBA 直传后端
        // 复制 + 落盘 + 入库一条龙（沿用 finish_screenshot_rgba 亚秒路径）。
        const out = await renderResultCanvas();
        const ctx = out.getContext("2d");
        if (!ctx) throw new Error("canvas 2d 不可用");
        const id = ctx.getImageData(0, 0, out.width, out.height);
        // body 布局（小端）与后端 finish_screenshot_rgba 严格一致：
        // u32 width + u32 height + u32 text_len + text_utf8(可空) + rgba
        const text = ocr?.fullText?.trim() || null;
        const textBytes = new TextEncoder().encode(text ?? "");
        const body = new Uint8Array(12 + textBytes.length + id.data.length);
        const dv = new DataView(body.buffer);
        dv.setUint32(0, out.width, true);
        dv.setUint32(4, out.height, true);
        dv.setUint32(8, textBytes.length, true);
        body.set(textBytes, 12);
        body.set(id.data, 12 + textBytes.length);
        // 不 await 复制：`set_image` 在 Windows 上会被剪贴板查看器链**同步**拖慢到秒级
        // （实测 12MB 图单次写入 1.7s——第三方剪贴板历史工具在 SetClipboardData 时同步
        // 读大图），await 它 = 完成按钮永远慢。fire-and-forget 发出请求，复制/落盘/入库
        // 由后端后台执行；失败由后端 emit `screenshot-copy-failed` → 主窗口 toast
        // （截图窗即将销毁，不在这里提示）。
        void invoke("finish_screenshot_rgba", body).catch(() => {
          /* 后端已 emit 失败提示，这里只为吞掉 unhandled rejection */
        });
        // fire-and-forget 的 IPC 在 webview 销毁时可能丢失：等 ~150ms 让 postMessage
        // 送达后端（窗口此时仍显示但马上关，150ms 内用户无感）再销毁。
        await sleep(150);
        close();
      }
    } catch (e) {
      logger.error("复制图片失败", e);
      // 窗口已隐藏：恢复显示再报错，让用户看到错误（规则 15.3 不静默）
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch {
        /* 恢复失败也无碍：toast 仍会报错 */
      }
      showToast(`复制失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  // 每次渲染把最新一份写进 ref，供快捷键 effect 调用（见 copyImageRef 声明处注释）。
  copyImageRef.current = copyImage;

  /* ===== 三个主力出口：标注态工具栏与 result 态「更多」面板共用 =====
   *
   * 旧实现里 saveToGallery / pinImage 开头都是 `if (!resultPath) return`。
   * 那在 result 态成立（那时 resultPath 已经有了），但标注态 resultPath 是 null，
   * 把这两个函数直接接到工具栏上就是静默无反应 —— 正是之前修过一整轮的
   * “点了没反应”同一个坑。
   *
   * 所以拆成两层：具体动作只接受一个已知 path，“把 path 弄出来 + 报错 + busy”
   * 统一交给 runExit（规则 11：公共函数收口）。ensureResultPath 幂等，
   * 所以 result 态走同一条路不会重复合成。 */

  /** 出口外壳：busy 护栏 + 先确保结果图落盘 + 失败一律 toast（规则 15.3）。
   *  ❗ 失败时**不关窗**：窗关了 toast 就没地方显示，用户只看到“点了一下就没了”。 */
  const runExit = useCallback(
    async (label: string, fn: (path: string) => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        const path = await ensureResultPath();
        await fn(path);
      } catch (e) {
        logger.error(`${label}失败`, e);
        showToast(`${label}失败：${errText(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, ensureResultPath, showToast],
  );

  /** 另存为图片文件。path 由 runExit 给（结果态已是最终图，长截图=拼接长图）。
   *  保存后也进粘贴历史：复制已入库，保存不应例外（长截图/普通截图行为一致）。 */
  const saveImageTo = async (path: string) => {
    const dest = await save({
      defaultPath: `PastePanda-截图-${Date.now()}.png`,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] }],
    });
    if (!dest) return; // 用户取消：不报错也不关窗
    await invoke("save_image_file", { source: path, dest });
    // 入库：保存后也出现在粘贴历史（长截图修复的核心诉求）。fire-and-forget 不阻塞保存，
    // 失败仅告警（不影响用户已拿到的文件）。
    void invoke("insert_screenshot_to_history", {
      imagePath: path,
      ocrText: ocr?.fullText?.trim() || null,
    }).catch((e) => logger.warn("截图保存后入库失败（不影响保存）", e));
    close();
  };

  /** 贴图置顶。await 完才 close：旧实现立即 close()，
   *  贴图失败时截图窗已经没了，提示没地方显示。 */
  const pinImageAt = async (path: string) => {
    await invoke("open_pinned_image", { path });
    close();
  };

  const copyText = async (text: string) => {
    try {
      await invoke("copy_only", { text });
    } catch (e) {
      logger.error("复制文字失败", e);
      showToast(`复制文字失败：${errText(e)}`);
    }
  };

  const copyAllText = async () => {
    if (!ocr?.fullText) return;
    await copyText(ocr.fullText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1200);
  };

  /** 重试提前 OCR。工具栏「取文字」按钮的失败态用它（规则 11：公共函数收口）。
   *  ❗ preloadOcrStartedRef 必须先重置，否则 effect 开头就被它拦下，重试永远不会发生。 */
  const retryOcr = useCallback(() => {
    preloadOcrStartedRef.current = false;
    setOcrErr(null);
    setOcrStatus("idle");
    setOcrRetry((v) => v + 1);
  }, []);

  /** 工具栏「取文字」点击：完成态 → 展开/收起抽屉；失败态 → 重试。
   *  不直接复制全文：抽屉里还有逐行复制 / 二维码 / 提取表格 / AI 解释 / 送动作链，
   *  直接复制等于把这五个一起埋掉。一步到位那条路由 T 键负责。 */
  const onOcrButton = useCallback(() => {
    if (ocrStatus === "failed") {
      notePowerUsed("ocr"); // B 方案：点过即视为已发现
      retryOcr();
      return;
    }
    if (ocrStatus === "done" && ocr) setOcrDrawerOpen((v) => !v);
  }, [ocrStatus, ocr, retryOcr, notePowerUsed]);

  /** 工具栏「AI」点击。
   *
   *  ⚠️ 它**不需要** ensureResultPath —— AI 动作跑的是 OCR 文字，不是结果图，
   *  所以不走 runExit，也不必先合成落盘（那会白等一次 PNG 编码）。
   *  但没有文字时必须说清楚原因，不能默默开一个空面板（规则 15.3）。 */
  const onAiButton = useCallback(() => {
    if (ocrStatus === "running") {
      showToast("正在识别文字，稍等一下再点 AI");
      return;
    }
    if (!ocr?.fullText?.trim()) {
      showToast("图中未识别到文字，AI 没有可处理的内容");
      return;
    }
    void openAiRef.current();
  }, [ocrStatus, ocr, showToast]);

  /* ===== ⑤ 取文字 · 字级拖选（后端已返回逐字符 bbox） ===== */
  // 把每行每个字符的矩形收进 ref，供拖选命中检测用（避免闭包捕获陈旧 ocr）。
  useEffect(() => {
    const out: { key: string; x: number; y: number; w: number; h: number; ch: string }[] = [];
    ocr?.lines.forEach((line, i) =>
      line.words.forEach((wd, j) =>
        out.push({ key: `${i}-${j}`, x: wd.x, y: wd.y, w: wd.width, h: wd.height, ch: wd.text }),
      ),
    );
    ocrRectsRef.current = out;
  }, [ocr]);
  // 让全局 Esc 处理能读到最新值，无需改 effect 依赖。
  ocrBarOpenRef.current = ocrBarOpen;
  ocrSelRef.current = ocrSel;

  const toPhysical = (clientX: number, clientY: number) => {
    const cv = canvasRef.current;
    if (!cv) return { px: 0, py: 0 };
    const r = cv.getBoundingClientRect();
    return { px: (clientX - r.left) * dpr, py: (clientY - r.top) * dpr };
  };

  const copyOcrSel = async () => {
    if (!ocr) return;
    const ordered = [...ocrSel].sort((a, b) => {
      const [ai, aj] = a.split("-").map(Number);
      const [bi, bj] = b.split("-").map(Number);
      return ai - bi || aj - bj;
    });
    const text = ordered.map((k) => {
      const [i, j] = k.split("-").map(Number);
      return ocr.lines[i]?.words[j]?.text ?? "";
    }).join("");
    if (!text) return;
    await copyText(text);
    setOcrBarOpen(false);
    setOcrDrag(null);
    setOcrSel(new Set());
    // 选区一清，高亮框就没了，所以反馈得走 toast（规则 15.3：不静默）。
    showToast(`已复制 ${ordered.length} 字`, true);
  };

  // 浮复制条位置：四象限翻转（右下→左下→右上→左上→钳进视口），贴屏幕边缘不溢出。
  // 与 layoutSizeLabel 同模式：位置由纯函数算，CSS 只管长相（见 ocrBarPos.ts）。
  const ocrCopyBarStyle = (drag: { x: number; y: number; w: number; h: number }) => {
    const l = layoutOcrCopyBar(
      { x: css(drag.x), y: css(drag.y), w: css(drag.w), h: css(drag.h) },
      window.innerWidth,
      window.innerHeight,
    );
    return { left: l.left, top: l.top };
  };

  // 橡皮筋拖选命中检测（与 maskGeom 同口径：共边不算重叠）。
  /** 字层 pointer-events:none，所有选字手势收口到标注画布（onAnnotMouseDown）后，
   * 由本函数起手。命中测试经 wordAt（排除隐私行）。 */
  const onOcrSelectMove = (e: MouseEvent) => {
    const s = ocrDragRef.current;
    if (!s) return;
    const { px, py } = toPhysical(e.clientX, e.clientY);
    if (Math.abs(px - s.x) > 4 || Math.abs(py - s.y) > 4) s.moved = true;

    // 选字是「按下文字即进入、按住拖拽全程保持」的连续手势：模式在 mousedown 已按
    // 落点定（落字=选字 / 落空白=画标注），拖拽途中不再翻转。光标离开文字带时
    // selectSpan 返回 null，仅冻结上次选区、不转画标注——避免「正选字突然变画框」的断裂。
    // 跨行空白由 selectSpan 行带桥接续选，换行不中断。
    const sel = selectSpan(ocrRectsRef.current, s.key, px, py, annotations);
    if (sel) setOcrSel(sel);

    // 橡皮筋矩形仅作拖拽范围指示（真实选区以逐字高亮 ocrSel 为准）。
    setOcrDrag({
      x: Math.min(s.x, px),
      y: Math.min(s.y, py),
      w: Math.abs(px - s.x),
      h: Math.abs(py - s.y),
    });
  };

  const onOcrSelectUp = () => {
    window.removeEventListener("mousemove", onOcrSelectMove);
    window.removeEventListener("mouseup", onOcrSelectUp);
    const s = ocrDragRef.current;
    ocrDragRef.current = null;
    if (!s) return;
    if (!s.moved) {
      // 单击（未拖动）= 选中**整行**并弹复制条，不直接写剪贴板。
      //
      // ❌ 旧行为是“静默把一个字复制进剪贴板”，两头都不对：
      //  · 默认就是矩形工具，用户很可能只是想在文字上起手画个框或随手点一下，
      //    却把他剪贴板里原有的东西覆盖掉了；
      //  · 就算真想取字，一个字也几乎没用。
      // 选中整行 + 等用户点「复制」，既回到了旧版行级框的有用粒度，
      // 又保证剪贴板只在明确意图下才被改写。
      // （结果态不走这里：那边点一下就是直接复制整行，见 onOcrResultDown。）
      //
      // ⚠️ 必须用起手时存的 s.key：window 监听器捕获的是注册时刻的闭包，
      // 此刻 setOcrSel(new Set([key])) 尚未生效，读 [...ocrSel][0] 会拿到陈旧值。
      setOcrDrag(null);
      if (s.key) {
        setOcrSel(selectLine(ocrRectsRef.current, s.key, annotations));
        setOcrBarOpen(true);
      } else {
        setOcrSel(new Set());
      }
    } else {
      setOcrBarOpen(true); // 拖选：弹浮复制条
    }
  };

  // 结果态：点一下即复制**整行**（旧版行级框就是这个行为）。
  // 逐字化之后一度变成“点一下只复制一个字”，对“看到文字想拿走”这个主要场景是退化。
  // 标注态选字走 onAnnotMouseDown（字层 pointer-events:none 不抢事件）。
  const onOcrResultDown = (e: React.MouseEvent, i: number) => {
    if (phase !== "result") return;
    e.stopPropagation();
    void copyRow(i);
  };

  /** 从标注画布 mousedown 起手 OCR 选字（smart：落字拖；modifier：Ctrl+落字拖）。 */
  const startOcrSelect = (key: string, px: number, py: number, mode: OcrSelectMode) => {
    ocrDragRef.current = {
      x: px,
      y: py,
      moved: false,
      key,
      mode,
    };
    setOcrSel(new Set([key]));
    setOcrDrag({ x: px, y: py, w: 0, h: 0 });
    setOcrBarOpen(false);
    window.addEventListener("mousemove", onOcrSelectMove);
    window.addEventListener("mouseup", onOcrSelectUp);
  };

  /** 起手画标注（从按下点 px,py 开始）。供 onAnnotMouseDown 正常路径与
   *  智能意图「拖出文字区转标注」复用——两者都是「空白处按下=画标注」。 */
  const startDrawDraft = (px: number, py: number) => {
    // 遮罩的轨迹形态：brush 用笔刷路径裁切效果；magic 把同一条路径当泛洪种子
    // （draw.ts brushSeedMask → magicMaskFromSeeds）。两者都必须初始化并采集 points——
    // ❌ magic 漏初始化的后果（审查 C-1）：标注带着 shape:"magic" 却没有 points，
    // 渲染时 strokeBrushPath 对空数组取 pts[0][0] 直接抛 TypeError，一拖就崩。
    const isStrokeMask = SHAPE_TOOLS.has(tool) && (maskShape === "brush" || maskShape === "magic");
    const a: Annotation = {
      id: nextId(),
      type: tool,
      color,
      width: lineW,
      x: px,
      y: py,
      x2: px,
      y2: py,
      points: tool === "pen" || isStrokeMask ? [[px, py]] : undefined,
      text: tool === "number" ? String(nextNumber()) : undefined,
      size: tool === "number" ? fontPx : undefined,
      arrowStyle: tool === "arrow" ? arrowStyle : undefined,
      strength: tool === "mosaic" ? mosaicStrength : tool === "blur" ? blurStrength : tool === "dewarp" ? dewarpStrength : undefined,
      shape: SHAPE_TOOLS.has(tool) ? maskShape : undefined,
    };
    if (tool === "number") {
      commitAnnot(a);
      return;
    }
    draftRef.current = a;
  };

  const copyRow = async (idx: number) => {
    const line = ocr?.lines[idx];
    if (!line) return;
    await copyText(line.text);
    setCopiedRow(idx);
    setTimeout(() => setCopiedRow(null), 1200);
  };



  const reselect = () => {
    setPhase("select");
    setSel(null);
    setSelDraft(null);
    selFixedRef.current = false; // 解除固定 → hover 吸附恢复，可以重新挑窗口（规则 11.1）
    lastSnapRef.current = null;
    setSnapWin(null);
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    clearOcrState();
    setResultPath(null);
  };

  /** 下一个序号 = 已有序号里的最大值 + 1。
   *
   *  旧实现用一个只增不减的 numSeqRef，只在重选区时归零 —— 画 1/2/3 后撤销掉 3，
   *  再画会得到 4，序号就断了。从当前标注算则自然接上，且删中间的也不会重号。 */
  const nextNumber = () =>
    annotationsRef.current.reduce(
      (m, a) => (a.type === "number" ? Math.max(m, Number.parseInt(a.text ?? "0", 10) || 0) : m),
      0,
    ) + 1;

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

  // 刷新 ref（见 openAiRef 声明处注释）。必须放在 openAi 定义之后。
  openAiRef.current = () => void openAi();
  saveExitRef.current = () => void runExit("保存", saveImageTo);
  insertEditorRef.current = () => void insertToEditor();

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


  /* ===== select 态：微信同款交互（hover 即选区 / 拖选 / 选区移动） ===== */
  const onSelectMouseDown = (e: React.MouseEvent) => {
    if (phase !== "select") return;
    setSnapWin(null); // 点选即退出 hover 吸附态的窗口轮廓（拖选固定后不再显示双层）
    kbActiveRef.current = false; // 拖选/点选退出键盘遍历态
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
    // 选择态下若已切到文字工具并点画面：直接固定当前选区、进标注态、在该点弹输入框，
    // 否则点击只会被当成画新选区，文字工具「点了不弹框」。无选区（桌面空白）时退回原逻辑。
    if (selRef.current && tool === "text") {
      selFixedRef.current = true;
      setPhase("annotate");
      setTextDraft({ x: px, y: py });
      return;
    }
    // 微信同款：select 态按下一律画新矩形（任意起点，含吸附窗口内），
    // 不再"按在选区内=平移"。平移改为选区确认后用八向手柄拖移（:2789）。
    dragRef.current = { startX: px, startY: py, curX: px, curY: py };
    // 只清掉可能残留的旧草稿，**不**设 0×0 起点：草稿一旦非空就会接管蒙版与选区框的显示，
    // 而这一刻用户还没拖出任何东西（见 displaySel 处的注释）。
    setSelDraft(null);
  };
  const onSelectMouseMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
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
        ? applyMagnet(raw, [...winRectsRef.current, ...(lastSnapRef.current ? [lastSnapRef.current.ctrl] : [])], sc.width, sc.height)
        : raw;
      // 草稿只在**原始**拖动距离过了 DRAG_MIN 之后才发布 —— 与 finalizeSelectDrag 的提交
      // 门槛同一个判据、同一个量。不能拿 draft 的宽高去判：applyMagnet 有 4px 防退化兜底，
      // 那样门槛永远成立，抖一下就会看到选区框塌成光标处的小方块（见 geometry.DRAG_MIN）。
      setSelDraft(raw.w >= DRAG_MIN && raw.h >= DRAG_MIN ? draft : null);
      updateMag(px, py);
      return;
    }
    // hover 即选区（微信同款：移动鼠标选区跟随窗口；拖选有效后固定；手柄调整中不吸附）
    // 固定区域预览态：暂停 hover 吸附，让用户拖改区域而不被窗口抢走
    if (selFixedRef.current || resizing || fixedPreview) return;
    kbActiveRef.current = false; // 鼠标一动即退出键盘遍历态，回到 hover 吸附
    const now = Date.now();
    if (now - snapTsRef.current >= 90) {
      snapTsRef.current = now;
      // px/py 是底图局部坐标，后端要的是屏幕坐标；返回的矩形反过来要换回局部。
      const [sx, sy] = toScreenPt(screen, px, py);
      void invoke<SnapTargets | null>("snap_window_at", {
        x: Math.round(sx),
        y: Math.round(sy),
      })
        .then((s) => {
          if (dragRef.current) return; // 已进入拖选
          if (phaseRef.current !== "select") return;
          const cur = lastSnapRef.current;
          // 桌面空白（后端返回 null）时吸附整屏，而非微信式全暗无选区：
          // 用户悬停桌面即框当前显示器整屏（QQ / Snipaste 同款全屏吸附）。
          const full: SnapTargets | null = screen
            ? { win: { x: 0, y: 0, w: screen.width, h: screen.height }, ctrl: { x: 0, y: 0, w: screen.width, h: screen.height } }
            : null;
          const next: SnapTargets | null =
            s && s.ctrl.w >= 4 && s.ctrl.h >= 4
              ? { win: toLocalRect(screen, s.win), ctrl: toLocalRect(screen, s.ctrl) }
              : full;
          // 双层迟滞防抖：决定「窗口层 / 控件层」是否切换，防光标边界微抖时框反复跳
          const target = resolveSnapTargets(cur, next, px, py);
          if (target) {
            lastSnapRef.current = target;
            // 钳制到屏幕内：后端 UIA/DWM 矩形在高 DPI 偏移 / 全屏窗口阴影扩展下可能出界
            //（负坐标或超界），出界的 sel 会让标注态 shade-block 蒙版切成 4 段
            //（拖拽把手钳制后恢复的正是这个）。桌面空白走 full 分支不受影响。
            const sc = screen;
            setSel(sc ? clampRect(target.ctrl, sc.width, sc.height) : target.ctrl);
            setSnapWin(target.win);
          } else {
            lastSnapRef.current = null;
            setSel(null);
            setSnapWin(null);
          }
        })
        .catch(() => {
          /* 吸附失败忽略 */
        });
    }
  };
  const finalizeSelectDrag = () => {
    // 先取引用并立刻清空，确保任何提前返回路径都不会留下悬挂 dragRef。
    const d = dragRef.current;
    dragRef.current = null;
    const wasFixed = fixedPreview;
    if (!d) {
      // 固定区域预览态：点空白（未拖动）也退出预览，回到 hover 吸附
      if (wasFixed) {
        setFixedPreview(false);
        fixedPreviewRef.current = false;
      }
      return;
    }
    const w = Math.abs(d.curX - d.startX);
    const h = Math.abs(d.curY - d.startY);
    if (w >= DRAG_MIN && h >= DRAG_MIN) {
      // 拖选有效 → 固定（移动不再吸附，微信同款）并自动进入标注。
      // 提交也要走 applyMagnet，否则吸附预览（selDraft 已磁吸）与落点（未磁吸）瞬间跳变。
      const raw = { x: Math.min(d.startX, d.curX), y: Math.min(d.startY, d.curY), w, h };
      const sc = screen;
      const magnet = sc
        ? applyMagnet(raw, [...winRectsRef.current, ...(lastSnapRef.current ? [lastSnapRef.current.ctrl] : [])], sc.width, sc.height)
        : raw;
      selFixedRef.current = true;
      setSel(magnet);
      setPhase("annotate");
    } else {
      // 原地点击（单击）：提交当前吸附窗口进标注；无选区(桌面空白)则保持 hover 吸附
      if (selRef.current && phaseRef.current === "select") {
        selFixedRef.current = true;
        setPhase("annotate");
      } else {
        selFixedRef.current = false;
      }
    }
    // 固定区域预览态：拖/点采纳后退出预览（进入标注或回吸附）
    if (wasFixed) {
      setFixedPreview(false);
      fixedPreviewRef.current = false;
    }
    setSelDraft(null);
    hideMag();
  };
  const onSelectMouseUp = () => finalizeSelectDrag();

  // ⚠️ 拖选中途移出画布松手 → 元素级 onMouseUp 收不到 → dragRef/selDraft 永不清除 → 幽灵框。
  // 挂 window 级兜底：无论在哪松手 / 失焦，都能清空拖拽态（与元素 handler 互斥，靠 dragRef 判空防重复）。
  finalizeSelectDragRef.current = finalizeSelectDrag;
  useEffect(() => {
    const onWinUp = () => {
      if (dragRef.current) finalizeSelectDragRef.current();
    };
    const onWinBlur = () => {
      // 光标拖到别的窗口里松手：本窗失焦，mouseup 不会发到我们这，
      // 直接丢弃这次拖拽，避免遗留幽灵框 / 下次移动续画。
      if (dragRef.current) {
        dragRef.current = null;
        setSelDraft(null);
        hideMag();
      }
    };
    window.addEventListener("mouseup", onWinUp);
    window.addEventListener("blur", onWinBlur);
    return () => {
      window.removeEventListener("mouseup", onWinUp);
      window.removeEventListener("blur", onWinBlur);
    };
    // hideMag 是 useCallback(…, []) 引用恒定，列进来不会导致重复订阅
  }, [hideMag]);

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


  /* 贴图「预览即钉」：浮动预览拖动定位（window 级监听，松手即停在拖到的位置） */
  const onPinFloatDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cur = pinPreviewRef.current;
    if (!cur) return;
    pinDragRef.current = { dx: e.clientX - cur.x, dy: e.clientY - cur.y };
    const onMove = (ev: MouseEvent) => {
      if (!pinDragRef.current) return;
      // 钳位常量要与初始定位同一套，否则“弹出来的位置”与“拖得到的边界”对不上。
      const nx = Math.max(0, Math.min(window.innerWidth - PIN_FLOAT_W, ev.clientX - pinDragRef.current.dx));
      const ny = Math.max(0, Math.min(window.innerHeight - PIN_FLOAT_H, ev.clientY - pinDragRef.current.dy));
      const np = { x: nx, y: ny };
      pinPreviewRef.current = np;
      setPinPreview(np);
    };
    const onUp = () => {
      pinDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
      // 点一下把手就松手（没真缩放）不入栈，见 snapshotUndoIfChanged
      snapshotUndoIfChanged();
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
  /* V6.19 吸管：从底图采样光标处颜色（选区本地坐标 → 全屏偏移）。
   * 采样本身走 lib/screenshot/pixelProbe —— 放大镜也用同一个实现，口径必须一致。 */
  const samplePixel = (px: number, py: number): string | null => {
    const base = baseImgRef.current;
    if (!base) return null;
    const r = selRef.current;
    const ox = r ? r.x : 0;
    const oy = r ? r.y : 0;
    return samplePixelHex(base, ox + px, oy + py)?.hex ?? null;
  };

  const onAnnotMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 长截图淡预览态：整个画面归预览层管，画布不接手。
    // 预览是从标注态工具栏进的，phase 仍是 annotate，所以预览框**以外**的单击
    // 会落到这块画布上变成画标注，而提示写的是「单击=截整页」。
    // select 态四个 handler 都加了这道守卫，漏的就是这一个。
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
      // 阻止 mousedown 默认聚焦：否则 browser 在 mouseup 时把刚创建的输入框 blur 掉，
      // 触发 onBlur→submitText("")→setTextDraft(null)，输入框一闪即逝（见 textInputRef effect）。
      e.preventDefault();
      // 微信同款：文字工具下点「已有文字」= 进编辑改字，而不是又建一个空框。
      // 命中检测现在覆盖整段文字（measureTextExtent），不再只有落点 8px 能选中。
      const hitTxt = [...annotations].reverse().find(
        (a) => a.type === "text" && pointHitAnnot(px, py, a),
      );
      if (hitTxt) {
        setTextDraft({ x: hitTxt.x, y: hitTxt.y, id: hitTxt.id, value: hitTxt.text ?? "" });
      } else {
        setTextDraft({ x: px, y: py });
      }
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
    // 去水印·平铺模式：点击画布即整屏自动检测去水印（动作型，类似自动打码点即执行）。
    // 手动模式不在此拦截，走下方 startDrawDraft 进入绘制态。
    if (tool === "dewarp" && dewarpMode === "tile") {
      runDewatermarkTile();
      return;
    }
    // ⑤ 标注与文字识别共存：字层 pointer-events:none，mousedown 全收口到此处。
    // ⚠️ 分流只在「默认中性工具 rect」下启用：用户显式切到模糊/马赛克/高亮/文字等
    // 任何工具 = 明确绘制意图，落字也直接画标注——否则「模糊」涂抹在文字上会被
    // 选字劫持，模糊完全画不出来（实测反馈：用了没效果）。
    if (
      tool === "rect" &&
      ocr &&
      ocr.lines.length > 0 &&
      ocrRectsRef.current.length > 0
    ) {
      const hit = pointInAnyWord(px, py, ocrRectsRef.current, annotations);
      if (shouldStartOcrSelect(hit, ocrSelectMode, e.ctrlKey || e.metaKey) && hit) {
        e.preventDefault();
        startOcrSelect(hit, px, py, ocrSelectMode);
        return;
      }
    }
    // 先做命中检测 → 选中已有元素（V5；Shift 多选，V6.19）。
    // 可否选中由 isSelectableAnnot 判定（遮罩类不参与），理由见那里的注释。
    if (tool !== "number") {
      const hit = [...annotations]
        .reverse()
        .find((a) => isSelectableAnnot(a) && pointHitAnnot(px, py, a));
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
    startDrawDraft(px, py);
  };
  const onAnnotMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    // 橡皮：实时画范围圈。必须在所有 early return **之前**，
    // 否则未拖动时就被下面的分支挡掉了 —— 而 hover 态才是最需要看见半径的时候。
    if (tool === "eraser") drawEraserCursor(px, py);
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
    // 有 points 就是轨迹类（pen / 橡皮预览 / 涂抹形态的遮罩），统一按采点走。
    // 判断条件用 `d.points` 而不是 `d.type === "pen"`：涂抹形态的马赛克/模糊/高亮
    // 类型不是 pen，但同样需要采点——按 type 判断会让它们退化成只记起止点的拖框。
    if (d.points) {
      // 高亮也是随轨迹采点（draw.ts 用 strokeBrushPath 描线）——不做“马克笔直条”，
      // 直条把整行盖成色块、深色下看不见内容（用户反馈），描线才始终可读。
      // 马赛克/模糊/高亮都是自由涂抹，跟手。
      d.points = [...d.points, [px, py]];
      // 包围盒跟着长：命中检测与选中框都用 x/y/x2/y2
      d.x = Math.min(d.x, px);
      d.y = Math.min(d.y, py);
      d.x2 = Math.max(d.x2, px);
      d.y2 = Math.max(d.y2, py);
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
    // ❗ 这里故意**不**叠 isSelectableAnnot，与上面的选中路径不同，别“顺手统一”：
    // 这个 hit 问的是“这里到底有没有东西”，而不是“能不能选中”。遮罩也是东西。
    // 把遮罩排除掉的后果：拿马赛克笔快速点涂两下会凑成 dblclick → 落在“空白”上
    // → 直接完成并关窗，截图就没了。现在遮罩能接住这一下，恰好是道保险。
    const hit = [...annotations].reverse().find((a) => pointHitAnnot(px, py, a));
    // 微信同款：双击文字=进编辑改字（任意工具下都能改，不必先切文字工具）。
    if (hit && hit.type === "text") {
      setSelectedIds([]);
      setTextDraft({ x: hit.x, y: hit.y, id: hit.id, value: hit.text ?? "" });
      return;
    }
    if (!hit) void copyImage();
  };

  const onAnnotMouseUp = () => {
    // 元素移动结束：入 undo（只点选没拖动的不入栈，见 snapshotUndoIfChanged）
    if (annotMoveRef.current) {
      annotMoveRef.current = null;
      snapshotUndoIfChanged();
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    draftRef.current = null;
    // 橡皮擦：擦到笔迹就**切成多段**，擦到形状/文字才整删（eraseStrokes）。
    //
    // 旧实现走 eraseHits —— 划到就整个删，用户画了一条长曲线轻轻擦一下整条就没了。
    // 现在是混合行为：矩形/椭圆/箭头/文字/序号 没有“一段”的概念，仍然整删。
    //
    // undo 不用改：它是快照式的（moveSnapshotRef 存整个 annotations 数组），
    // “删 1 个 + 加 3 段”对它和“删 1 个”完全一样。
    if (tool === "eraser" && d.points && d.points.length > 0) {
      const { deleted, split } = eraseStrokes(d.points, annotations, eraserRadius);
      if (deleted.length > 0) {
        moveSnapshotRef.current = annotations;
        // 切分段的 id 在纯函数里是占位 0，这里统一分配（纯函数不能持有自增状态）
        const fresh = split.map((seg) => ({ ...seg, id: nextId() }));
        setAnnotations((prev) => [...prev.filter((a) => !deleted.includes(a.id)), ...fresh]);
        // 被删/被切分的元素若正处于选中态，选中 id 会变成悬空引用
        setSelectedIds((ids) => ids.filter((id) => !deleted.includes(id)));
        snapshotUndo();
      } else {
        // 一个都没擦到（在空白处擦、或没擦准）：draft 层已经把橡皮轨迹画在画布上了，
        // 而 annotations 没变 → 不会触发重绘 → 那条轨迹会一直留在画面上。
        // 与下方「零尺寸误点」同款处理（那处已修，这处是漏掉的另一半）。
        redraw();
      }
      return;
    }
    // 过滤零尺寸误点（矩形/椭圆/箭头/高亮/马赛克/模糊）
    if (d.type !== "pen" && Math.abs(d.x2 - d.x) < 2 && Math.abs(d.y2 - d.y) < 2) {
      // ⚠️ 丢弃草稿后必须重绘：mousedown→mousemove（哪怕 1px 抖动）已把草稿画上画布，
      // 不清理会在点击处残留草稿方块——遮罩类单点是整块采样/纯色块（高亮=当前色，
      // 实测通病：点击后出现绿色方块就是残留的高亮草稿），所有工具都一样。
      redraw();
      return;
    }
    commitAnnot(d);
  };

  /* 文字输入提交 */
  const submitText = (value: string) => {
    // 防重入：Enter 已提交 / Esc 已取消后，卸载时的 blur 调到这里直接返回，不落第二份。
    if (textSubmittedRef.current) return;
    textSubmittedRef.current = true;
    if (textDraft && value.trim()) {
      // 真实包围盒写进 x2/y2：选中框、后续命中检测都准（否则退化为落点 8px）。
      // 必须带上折行宽度，与 drawAnnot 同口径（canvas.width - a.x）：
      // 不带的话量出来是“不折行”的宽而矮的盒子，折行后的第二、第三行就选不中了。
      // 画布折行宽度 = 输入框实际渲染宽度（WYSIWYG）：方案 A 下框默认一般长度 120px、
      // 随内容增长、到选区边界才换行，落字必须按“框里真实换行点”来折，预览才不漂移。
      // 没有输入框（极端兜底）时退回“选区剩余宽”。
      const boxEl = textInputRef.current;
      const boxContentCss = boxEl ? boxEl.clientWidth - TEXT_PAD * 2 : undefined;
      const availPx =
        boxContentCss != null
          ? Math.max(1, boxContentCss * dpr)
          : selRef.current
            ? Math.max(1, selRef.current.w - textDraft.x)
            : undefined;
      const ext = measureTextExtent(value, fontPx, availPx);
      const patch = {
        text: value,
        color,
        width: lineW,
        size: fontPx,
        x: textDraft.x,
        y: textDraft.y,
        x2: textDraft.x + ext.w,
        y2: textDraft.y + ext.h,
      };
      if (textDraft.id != null) {
        // 编辑已有文字：原地更新，并压 undo 快照（与 commitAnnot 走同一个收口）
        pushUndoSnapshot();
        setAnnotations((prev) => prev.map((a) => (a.id === textDraft.id ? { ...a, ...patch } : a)));
      } else {
        commitAnnot({ id: nextId(), type: "text", ...patch });
      }
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
        const hit = await invoke<SnapTargets | null>("snap_window_at", { x: cx, y: cy });
        if (
          hit &&
          !cancelled &&
          phaseRef.current === "select" &&
          !selRef.current &&
          hit.ctrl.w >= 4 &&
          hit.ctrl.h >= 4
        ) {
          const localCtrl = toLocalRect(screen, hit.ctrl);
          const localWin = toLocalRect(screen, hit.win);
          // 钳制到屏幕内（同 hover 吸附，防高 DPI 偏移出界矩形切出 4 段蒙版）
          setSel(clampRect(localCtrl, screen.width, screen.height));
          setSnapWin(localWin);
          // Tier3：顺带枚举当前窗控件，键盘遍历（Tab / 方向键）可零延迟启动，
          // 且首次遍历从「光标所在控件」开始，而非窗口中心——无需额外 RPC 或鼠标移动。
          if (screen && !cancelled && phaseRef.current === "select") {
            const ok = await loadControls(localWin);
            if (ok && !cancelled && phaseRef.current === "select" && kbCtrlsRef.current.length > 0) {
              const curX = cx - (screen?.originX ?? 0);
              const curY = cy - (screen?.originY ?? 0);
              let best = 0;
              let bestD = Infinity;
              kbCtrlsRef.current.forEach((c, i) => {
                const d = Math.hypot(c.x + c.w / 2 - curX, c.y + c.h / 2 - curY);
                if (d < bestD) {
                  bestD = d;
                  best = i;
                }
              });
              kbIndexRef.current = best;
            }
          }
        }
      } catch (e) {
        logger.warn("自动框选当前窗口失败", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, phase, sel, loadControls]);

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
      // 步长从 2 改成 1：档位已经放到属性条上了，滚轮在这里只负责微调
      if (tool === "mosaic") {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        setMosaicStrength((v) => {
          const nv = Math.max(2, Math.min(40, v + delta));
          showHint(`马赛克色块：${nv}px`);
          return nv;
        });
      } else if (tool === "blur") {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        setBlurStrength((v) => {
          const nv = Math.max(1, Math.min(40, v + delta));
          showHint(`模糊半径：${nv}px`);
          return nv;
        });
      } else if (tool === "dewarp") {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -1 : 1;
        setDewarpStrength((v) => {
          const nv = Math.max(2, Math.min(40, v + delta));
          showHint(`去水印羽化：${nv}px`);
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
        // 必须走 canvasToDataUrl（toBlob）—— out.toDataURL 是**同步**全尺寸 PNG 编码。
        // 这一段恰好跑在“刚进标注态”，也就是用户伸手去点“完成”的那一刻：
        // 主线程被冻住几百毫秒，点击事件排在后面，表现就是“完成按钮要等一下才响应”。
        // （canvasToDataUrl 的注释里已经警告过这件事，这两处当时漏了。）
        const dataUrl = await canvasToDataUrl(out);
        const tmpPath = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
        // 登记为临时图：它只是喂 OCR 的中间产物（无损 PNG），与最终结果图是两个文件；
        // 不登记的话每截一次图就在 screenshots/ 里永久多留一张全尺寸 PNG。后端关窗时删。
        void invoke("mark_ocr_temp", { path: tmpPath }).catch(() => {});
        const res = await ocrImage(tmpPath);
        if (phaseRef.current !== "annotate" && phaseRef.current !== "result") return;
        setOcr(res);
        if (res.fullText?.trim()) {
          // 这里曾经启一个 6s 定时器把状态退回 idle（胶囊自动收起）。
          // 那是「OCR 藏太深」的直接原因：收起之后标注态再无任何入口，
          // 只剩一个界面上从未写过的 Ctrl+R——等于把功能做成了限时闪现。
          // 现在 done 是终态，由工具栏「取文字」按钮的行数角标一直展示。
          setOcrStatus("done");
        } else {
          setOcrStatus("empty");
        }
      } catch (e) {
        // 失败不能再当成 empty：那样界面上与"图里没文字"完全一样，
        // 用户既不知道出了错，也没有重试的路（OCR 首次加载模型慢，超时很常见）。
        logger.warn("提前 OCR 失败", e);
        setOcrErr(errText(e));
        setOcrStatus("failed");
      }
    })();
    // ocrRetry 入依赖：点"重试"时 phase/screen/ocr 都没变，没它 effect 不会重跑
  }, [phase, screen, ocr, ocrRetry]);

  /* ===== 渲染 ===== */
  if (!screen) {
    return (
      <div
        className="shot-root"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-primary, #fff)" }}
      >
        {captureError ? (
          <div
            style={{
              maxWidth: 420, padding: "14px 18px", borderRadius: 12, fontSize: 12,
              background: "color-mix(in srgb, var(--danger, #F87171) 15%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger, #F87171) 40%, transparent)",
              color: "var(--danger, #FCA5A5)", lineHeight: 1.7, textAlign: "center",
            }}
          >
            <div>截图失败：{captureError}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: "var(--accent-solid, #2D78C2)", color: "#fff", cursor: "pointer", fontSize: 12 }}
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
                style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid var(--shot-bar-border, rgba(255,255,255,0.3))", background: "transparent", color: "var(--shot-bar-text, #E6EDF7)", cursor: "pointer", fontSize: 12 }}
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
  // 显示选区：select 态取拖选草稿（橡皮筋）；标注/结果态**强制用真实选区 sel**——
  // selDraft 有一条提前 return 路径不清空（finalizeSelectDrag 的 !d 分支），
  // 一旦残留，shade-block 蒙版 / 选区框 / 工具栏会按残留草稿切出 4 段蒙版（历史 bug）。
  //
  // 「草稿够不够格接管显示」的判断已经收口到**发布草稿的那一处**（onSelectMouseMove 里按
  // 原始拖动距离与 DRAG_MIN 比），所以这里不再重复判一遍尺寸 —— 之前在这里判 selDraft.w >= 4
  // 是错的：selDraft 出自 applyMagnet，它有 4px 防退化兜底，门槛永远成立。
  const displaySel = phase === "select" ? (selDraft ?? sel) : sel;

  // 全屏/近全屏选区判定（物理像素，≥98% 容 DWM 阴影扩展 1-2px）：
  // 全屏时 4 块 shade-block 蒙版尺寸为 0（零暗化）→ 改用四边暗带（.edge-band）+ 边框强化。
  const isFullscreen =
    displaySel != null &&
    screen != null &&
    displaySel.w >= screen.width * 0.98 &&
    displaySel.h >= screen.height * 0.98;

  // 选区框逐边内缩：贴屏幕边缘的边向内缩 2px（CSS 像素）——边框画在屏幕最外圈会被
  // 显示器物理边缘/圆角裁切而不可见（全屏与贴边选区都反馈过）。只改**显示位置**，
  // 截取范围（sel）不变；贴边判定用物理像素容差 4px。
  // 2px 是折中：4px 缝隙太明显（用户反馈），1px 可能仍被边缘裁切；全屏时外圈暗带
  // 覆盖边缘区域，边框落在暗带内无缝隙感。
  const edgeInsetL =
    displaySel != null && screen != null && displaySel.x <= 4 ? 2 : 0;
  const edgeInsetT =
    displaySel != null && screen != null && displaySel.y <= 4 ? 2 : 0;
  const edgeInsetR =
    displaySel != null &&
    screen != null &&
    displaySel.x + displaySel.w >= screen.width - 4
      ? 2
      : 0;
  const edgeInsetB =
    displaySel != null &&
    screen != null &&
    displaySel.y + displaySel.h >= screen.height - 4
      ? 2
      : 0;

  // 工具栏位置：右对齐选区右边缘、优先选区下方（微信 / QQ / Snipaste 同款）。
  // 四种边界情况收在 layoutToolbar 里并配了单测（lib/screenshot/toolbarPos.ts）。
  // busy 时属性条不渲染，布局里也不能再给它留高度，否则垂直避让会多算 34px
  /** 尺寸标签位置。用 CSS 像素：标签是 .sel-rect 的子元素，而 .sel-rect 的
   *  left/top/width/height 都是 css() 换算过的。 */
  const sizeLabel = layoutSizeLabel(
    css(displaySel?.y ?? 0),
    css(displaySel?.h ?? 0),
    window.innerHeight,
  );
  const showAttrBar = ATTR_TOOLS.has(tool) && !busy;

  const tbLayout = layoutToolbar(
    sel
      ? { x: css(sel.x), y: css(sel.y), w: css(sel.w), h: css(sel.h) }
      : { x: 0, y: 0, w: 0, h: 0 },
    tbSize.w,
    tbSize.h,
    showAttrBar ? ATTR_BAR_H : 0,
    window.innerWidth,
    window.innerHeight,
  );
  // OCR 模式胶囊：锚定选区上缘右上角（遮罩死区，不压标注）。宽度实测后右对齐。
  const pillLayout = sel
    ? modePillPos(
        { x: css(sel.x), y: css(sel.y), w: css(sel.w), h: css(sel.h) },
        pillSize.w,
        pillSize.h,
        window.innerWidth,
        window.innerHeight,
      )
    : { left: 0, top: 0 };
  // result 态出口面板：复用 layoutToolbar —— 它算的就是"贴选区下方、右对齐选区右边缘、
  // 放不下翻上方 / 贴内部底边"，而 result 态工具栏已经消失，那个位置正好留给它。
  const actLayout = layoutToolbar(
    sel
      ? { x: css(sel.x), y: css(sel.y), w: css(sel.w), h: css(sel.h) }
      : { x: 0, y: 0, w: 0, h: 0 },
    actSize.w,
    actSize.h,
    0, // 出口面板下面不再挂属性条
    window.innerWidth,
    window.innerHeight,
  );

  // OCR 胶囊 / 抽屉的位置：跟随选区右外侧，避开工具栏（lib/screenshot/panelPos.ts）。
  // 两者用**同一个锚点**，点胶囊就是原地展开成抽屉，位置连续不跳。
  const panelLayout = layoutSidePanel(
    sel
      ? { x: css(sel.x), y: css(sel.y), w: css(sel.w), h: css(sel.h) }
      : { x: 0, y: 0, w: 0, h: 0 },
    OCR_PANEL_W,
    window.innerWidth,
    window.innerHeight,
    // 标注态避工具栏；result 态工具栏已经不在了，改避出口面板
    phase === "annotate" && sel
      ? { x: tbLayout.left, y: tbLayout.top, w: tbSize.w, h: tbSize.h }
      : phase === "result" && sel
        ? { x: actLayout.left, y: actLayout.top, w: actSize.w, h: actSize.h }
        : null,
  );

  return (
    <div
      className="shot-root"
      onMouseDown={phase === "select" ? onSelectMouseDown : undefined}
      onMouseMove={phase === "select" ? onSelectMouseMove : undefined}
      onMouseUp={phase === "select" ? onSelectMouseUp : undefined}
      onDoubleClick={phase === "select" ? onSelectDoubleClick : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        // 贴图浮动预览态：右键 = 取消预览（不钉，图仍在剪贴板），不关窗
        if (pinPreviewRef.current) {
          setPinPreview(null);
          pinPreviewRef.current = null;
          return;
        }
        // 两级取消（规则 17.6，微信同款）：标注态右键 → 回选区态；选区/结果态右键 → 关窗。
        // 与 Esc 同语义，只是给鼠标用户一条等价路径（规则 17.1：鼠标全流程可达）。
        // 此前截图窗口完全没有 onContextMenu，右键是空的。
        // ⚠️ 长截图期间本窗已被 hide()，这条分支实际收不到事件。
        // 真正能中止的入口是状态小窗的"放弃"按钮（走 LONGSHOT_CONTROL 事件）。
        // 保留它只为覆盖"状态窗没开成、截图窗又提前恢复"这种异常路径。
        if (longShotRef.current) {
          abortLongRef.current = true; // 长截图进行中：先中止滚动，不关窗
          return;
        }
        if (phase === "annotate") {
          cancelAnnot();
          return;
        }
        void invoke("close_screenshot_window");
      }}
    >
      {/* 悬浮提示 portal 层：脱离工具栏层叠上下文，根治被属性条遮挡 + 上方翻转失效（见 TooltipLayer.tsx） */}
      <TooltipLayer />

      {/* 截图底图 */}
      <div className="shot-bg" style={{ backgroundImage: `url(${screen.dataUrl})` }} />

      {/* 选区外暗色遮罩：未选区时全屏暗层（0.5 + 淡入）提示已进入截图模式（方案 A）；
          选区时 4 块压暗；全屏/近全屏选区时 4 块尺寸为 0 → 改四边暗带（.edge-band） */}
      {phase === "select" && !displaySel && <div className="shade-enter" />}
      {displaySel && !isFullscreen && (
        <>
          <div className="shade-block" style={{ left: 0, top: 0, width: "100%", height: css(displaySel.y) }} />
          <div className="shade-block" style={{ left: 0, top: css(displaySel.y), width: css(displaySel.x), height: css(displaySel.h) }} />
          <div className="shade-block" style={{ left: css(displaySel.x + displaySel.w), top: css(displaySel.y), right: 0, height: css(displaySel.h) }} />
          <div className="shade-block" style={{ left: 0, top: css(displaySel.y + displaySel.h), width: "100%", height: `calc(100% - ${css(displaySel.y + displaySel.h)}px)` }} />
        </>
      )}
      {displaySel && isFullscreen && (
        <>
          {/* 屏幕四边 5px 暗带（rgba(10,14,24,0.5)，见 .edge-band）：全屏选区无遮罩对比，靠边缘暗带 + 强边框辨识 */}
          <div className="edge-band" style={{ left: 0, top: 0, width: "100%", height: 5 }} />
          <div className="edge-band" style={{ left: 0, top: 5, width: 5, height: "calc(100% - 10px)" }} />
          <div className="edge-band" style={{ right: 0, top: 5, width: 5, height: "calc(100% - 10px)" }} />
          <div className="edge-band" style={{ left: 0, bottom: 0, width: "100%", height: 5 }} />
        </>
      )}

      {/* 常驻操作提示条：让原本「隐身」的吸附/键盘遍历能力对用户可见；仅框选前（select 态）展示、
          首次使用数秒后自动淡出、累计展示若干次后排期退休。annotate 态不再重复弹（已有教练卡/NEW 引导）。 */}
      {hintVisible && phase === "select" && (
        <div className={`shot-hint${hintFading ? " fade-out" : ""}`}>
          <span><span className="hk">拖拽</span> 框选 · 松手自动标注</span>
          <span className="sep" />
          <span><span className="hk">悬停</span> 自动吸附窗口/控件</span>
          <span className="sep" />
          <span><span className="hk">Tab / 方向键</span> 切换控件</span>
          <span className="sep" />
          <span><span className="hk">Enter</span> 进入标注</span>
          <span className="sep" />
          <span><span className="hk">Esc</span> 退出</span>
          <span className="hk-close" title="关闭提示" onClick={closeHint}>×</span>
        </div>
      )}

      {/* Tier3 双层轮廓：外层淡蓝窗口边界（仅当控件明显小于窗口即 <97% 时显示，避免双框难看） */}
      {phase === "select" && snapWin && displaySel && !(displaySel.w >= snapWin.w * 0.97 && displaySel.h >= snapWin.h * 0.97) && (
        <div
          className="win-outline"
          style={{ left: css(snapWin.x), top: css(snapWin.y), width: css(snapWin.w), height: css(snapWin.h) }}
        />
      )}

      {/* 选区框 + 尺寸角标 */}
      {displaySel && (
        <div
          className={`sel-rect${fixedPreview ? " fixed-preview" : ""}${isFullscreen ? " full" : ""}`}
          style={{
            left: css(displaySel.x) + edgeInsetL,
            top: css(displaySel.y) + edgeInsetT,
            width: css(displaySel.w) - edgeInsetL - edgeInsetR,
            height: css(displaySel.h) - edgeInsetT - edgeInsetB,
          }}
        >
          {/* 尺寸标签：位置由 layoutSizeLabel 算（跟随选区、贴屏幕底部时翻到上方）。
              旧实现 CSS 写死 bottom:-30px，选区贴底时标签连带里面的操作提示一起被裁掉。 */}
          {phase === "select" && !fixedPreview && (
            <div
              className={`sel-size${sizeLabel.place === "inside" ? " inside" : ""}`}
              style={{ top: sizeLabel.top }}
            >
              <span>{isFullscreen ? `全屏 ${Math.round(displaySel.w)} × ${Math.round(displaySel.h)}` : `${Math.round(displaySel.w)} × ${Math.round(displaySel.h)}`}</span>
              <span className="hint">{isFullscreen ? "Enter 确认 · Esc 取消" : "单击进标注 · 拖选区移动 · 拖边缘缩放"}</span>
            </div>
          )}
          {/* 固定区域预览态：紫色虚框提示（替代尺寸标签），引导「拖可改 / Esc 重置」 */}
          {fixedPreview && (
            <div className="pin-preview-lbl">固定区域 · 拖可改 · Esc 重置</div>
          )}
          {/* B 方案：select 态选区八向缩放把手（微信同款；拖手柄时 hover 吸附自动暂停）。
              固定区域预览态不显示把手（此时是预览，不是编辑选区） */}
          {phase === "select" && !fixedPreview && (
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


      {/* 固定区域快捷按钮（锚定屏幕右下角，不随选区跳动，所以点得到）。

          ❌ 「钉当前选区」只能放在**标注态**：select 态开着 hover 吸附，每 90ms 改写一次 sel，
          而鼠标移向右下角按钮的一路上 mousemove 照常冒泡到根节点——等手到了按钮，
          sel 已经被按钮下方那个窗口顶替了，钉下去就是钉错区域。
          标注态的选区是已确认的（selFixedRef），不会再被 hover 动，才有「当前选区」可言。
          「清除」不依赖 sel，两个态都可以给。 */}
      {(phase === "annotate" || (phase === "select" && hasFixedRegion)) && (
        <button
          className="pin-quick-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (hasFixedRegion) {
              clearRegion();
              setFixedPreview(false);
              fixedPreviewRef.current = false;
            } else if (sel) {
              saveRegion();
            }
          }}
        >
          {hasFixedRegion ? "✕ 清除固定区域" : "📌 钉当前选区"}
        </button>
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
              // 光标随工具变化：文字=I-beam、其余=十字（强化切换感知）。
              // 橡皮用 none：已经有一个跟随鼠标的范围圈（.eraser-cursor），
              // 再叠一个系统光标会和圈心重叠、反而看不清圈到哪里。
              cursor: tool === "text" ? "text" : tool === "eraser" ? "none" : "crosshair",
            }}
            onMouseDown={phase === "annotate" ? onAnnotMouseDown : undefined}
            onMouseMove={phase === "annotate" ? onAnnotMouseMove : undefined}
            onMouseUp={phase === "annotate" ? onAnnotMouseUp : undefined}
            onDoubleClick={phase === "annotate" ? onAnnotDoubleClick : undefined}
            onMouseLeave={() => {
              // 鼠标移出选区要清圈，否则圈会卡在边缘不动
              if (tool === "eraser") drawEraserCursor(null, null);
            }}
          />
          {/* 橡皮范围圈层：只在橡皮工具下挂载，pointer-events: none 不吃事件。
              与标注画布同尺寸同坐标系，所以直接用物理像素坐标画。 */}
          {phase === "annotate" && tool === "eraser" && (
            <canvas
              ref={eraserCurRef}
              className="eraser-cursor"
              width={Math.max(1, Math.round(sel.w))}
              height={Math.max(1, Math.round(sel.h))}
              style={{ width: css(sel.w), height: css(sel.h) }}
            />
          )}
          {/* 选中框（DOM 层，替代 canvas 绘制）：每个选中元素一个淡蓝虚线框。
              半透明填充明确"选中态"，不再像"画布底色"（用户反馈）。 */}
          {phase === "annotate" &&
            selectedIds.length > 0 &&
            selectedIds.map((id) => {
              const a = annotations.find((x) => x.id === id);
              if (!a) return null;
              const ax = Math.min(a.x, a.x2) - 5;
              const ay = Math.min(a.y, a.y2) - 5;
              const aw = Math.abs(a.x2 - a.x) + 10;
              const ah = Math.abs(a.y2 - a.y) + 10;
              return (
                <div
                  key={id}
                  className="annot-sel-box"
                  style={{ left: css(ax), top: css(ay), width: css(aw), height: css(ah) }}
                />
              );
            })}
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
                // ❌ 把 8 个把手裹在一个「元素大小的定位盒」里，把手自身不能带尺寸。
                // 旧写法把 left/top/width/height 直接上在 .sel-handle 上，inline 样式
                // 盖掉了 CSS 的 width/height:8px，配上 border-radius:50%，8 个把手就各自
                // 变成一个**元素尺寸的椭圆**堆在一起（正方形元素则是圆）——
                // 用户报的「点击标注元素后出现空心椭圆或圆」就是这个。
                // 多选分支没有 inline 样式（把手相对 .sel-rect 定位），所以一直正常，
                // 这里改成同一种做法：尺寸给定位盒，把手只管自己的偏移。
                return (
                  <div
                    className="annot-handle-box"
                    style={{ left: css(ax), top: css(ay), width: css(aw), height: css(ah) }}
                  >
                    {dirs.map((dir) => (
                      <div
                        key={dir}
                        className={`sel-handle h-${dir}`}
                        onMouseDown={onAnnotHandleDown(dir)}
                      />
                    ))}
                  </div>
                );
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
          {/* ⑤ 取文字字层。两个态的粒度不同，是有意的：
              - 标注态：字层 pointer-events:none，事件全收口到标注画布（所以在文字上也能
                画标注）；它只负责把**已选中**的字高亮出来，因此只渲染选中的那几个。
                拖选 = 逐字；单击 = 整行（都要点复制条才写剪贴板）。
              - 结果态：一行一框，点一下直接复制整行。
              - 被马赛克/模糊盖住的行整行不渲染（见 isRowMasked），高亮不算遮蔽。 */}
          {ocr?.lines.map((line, i) => {
            const lb = lineBox(line);
            if (!lb) return null;
            if (isRowMasked({ x: lb.x, y: lb.y, w: lb.width, h: lb.height }, annotations)) return null;
            // 结果态：**一行一框**（点一下复制整行）。
            if (phase === "result") {
              return (
                <div
                  key={i}
                  className={`ocr-line${copiedRow === i ? " copied" : ""}`}
                  style={{ left: css(lb.x), top: css(lb.y), width: css(lb.width), height: css(lb.height) }}
                  onMouseDown={(e) => onOcrResultDown(e, i)}
                >
                  <span className="tip">{copiedRow === i ? "已复制 ✓" : "点击复制此行"}</span>
                </div>
              );
            }
            // 标注态：字层 pointer-events:none，它唯一的作用就是把**已选中**的字高亮出来，
            // 所以只渲染选中的那几个。
            // ❌ 不能无条件逐字渲染：一张文字密集的截图动辄几千字，每字一个 div 再套一个
            // span，就是上万个节点；而拖选时每次 mousemove 都 setOcrSel 触发整层重渲染。
            return line.words.map((w, j) => {
              if (!w) return null;
              const key = `${i}-${j}`;
              if (!ocrSel.has(key)) return null;
              return (
                <div
                  key={key}
                  className="ocr-line inert sel"
                  style={{
                    left: css(w.x),
                    top: css(w.y),
                    width: css(w.width),
                    height: css(w.height),
                    pointerEvents: "none",
                  }}
                />
              );
            });
          })}
          {/* 橡皮筋拖选矩形（标注态，物理像素） */}
          {ocrDrag && (ocrDrag.w > 0 || ocrDrag.h > 0) && (
            <div
              className="ocr-rubber"
              style={{ left: css(ocrDrag.x), top: css(ocrDrag.y), width: css(ocrDrag.w), height: css(ocrDrag.h) }}
            />
          )}
          {/* 拖选后浮复制条（位置四象限翻转，贴边自动翻到矩形内侧，见 ocrBarPos.ts） */}
          {ocrBarOpen && ocrSel.size > 0 && ocrDrag && (
            <div
              className="ocr-copy-bar"
              style={ocrCopyBarStyle(ocrDrag)}
            >
              <button className="primary" onClick={() => void copyOcrSel()}>
                复制 {ocrSel.size} 字
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setOcrBarOpen(false);
                  setOcrSel(new Set());
                  setOcrDrag(null);
                }}
              >
                取消
              </button>
            </div>
          )}
          {/* 自动打码「预览式」：橙色虚框轻预览（相对选区局部坐标）。点框排除/恢复，整批确认才打马赛克 */}
          {phase === "annotate" &&
            maskPreview?.map((b, i) => (
              <div
                key={i}
                className={`mask-preview${b.excluded ? " excluded" : ""}`}
                style={{
                  left: css(b.x),
                  top: css(b.y),
                  width: css(b.x2 - b.x),
                  height: css(b.y2 - b.y),
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMaskBox(i);
                }}
              >
                <span className="mask-preview-tip">{b.excluded ? "已排除" : "点击排除"}</span>
              </div>
            ))}
          {/* 文字标注输入框 + 附着迷你工具条（微信同款：输入框下方紧跟字号/色板） */}
          {textDraft && (() => {
            // 折行宽度：从文字起点到**选区右边界**（物理像素）。
            // 这与 drawAnnot 里的 ctx.canvas.width - a.x 是同一个量 —— 标注坐标就是选区局部坐标，
            // 而合成画布宽 = 选区宽。两边必须同口径，否则预览与落字的行数对不上。
            const availPx = selRef.current ? Math.max(1, selRef.current.w - textDraft.x) : 0;
            const availCss = availPx ? availPx / dpr : undefined;
            // 估算输入框高度（CSS px）：折行后行数 × 字号 × 行高 + 上下留白；用于贴底翻转判断。
            const draftLines = wrapLines(textDraft.value ?? "", fontPx, availPx).length || 1;
            const boxHCss = draftLines * fontCss * TEXT_LINE_HEIGHT + 4 + TEXT_PAD * 2;
            const effBoxH = textBoxHCss || boxHCss; // 真实框高优先，首帧未测量时用估算兜底
            const TOOLBAR_H = 34; // 文字附着迷你条高度
            const ANNOT_TOOLBAR_H = 56; // 底部主标注工具栏实际高度（含 padding/border），文字不能压在它上面
            const screenBottom = typeof window !== "undefined" ? window.innerHeight : 1e9;
            const selBottom = selRef.current
              ? (selRef.current.y + selRef.current.h) / dpr
              : screenBottom;
            // 可用底部 = min(选区底, 屏幕底) - 工具栏高：翻转判断要让出工具栏空间，
            // 否则选区贴屏幕底时文字/迷你条仍会被主工具栏遮住（旧实现忽略工具栏高度）。
            const viewBottomCss = Math.min(selBottom, screenBottom) - ANNOT_TOOLBAR_H;
            const flip = textDraft.y / dpr + effBoxH + 8 + TOOLBAR_H > viewBottomCss;
            return (
              <>
                <textarea
                  ref={textInputRef}
                  // key：新建/编辑切换时强制重挂载，让 defaultValue 重新回填已有文字
                  key={textDraft.id ?? "new"}
                  className="text-draft"
                  // 编辑已有文字时回填初始文本（新建则为空）
                  defaultValue={textDraft.value ?? ""}
                  // wrap=soft：碰到选区右边界自动换行（微信截图同口径）。
                  // 以前是 wrap="off" 不折行 —— 而合成画布就是选区大小，超出右边界的那段字
                  // 落字后直接被裁掉，输入框里却是完整的（内容丢失）。
                  // 现在两边都折：这里靠浏览器原生折行，画布靠 wrapLines，宽度同为 availPx。
                  wrap="soft"
                  // 在输入框内按下不冒泡到标注画布：避免点到输入框又触发 onAnnotMouseDown 重建/移位
                  onMouseDown={(e) => e.stopPropagation()}
                  // 内容变化按 scrollHeight 撑高（多行不被裁切）
                  onChange={(e) => autoSizeText(e.target)}
                  // color 必须跟当前标注色：不给的话 CSS 里是固定白色，
                  // 而提交后 drawAnnot 用 a.color，会看到文字突然变色
                  style={{
                    // 负偏移抵消 padding：视觉上有内边距（字不再顶着框线），
                    // 而文字的屏幕位置与 css(textDraft.x/y) 严格相等 —— 跟落字对得上。
                    left: css(textDraft.x) - TEXT_PAD,
                    top: css(textDraft.y) - TEXT_PAD,
                    padding: TEXT_PAD,
                    // 越界处理用“限尺寸 + 内部滚动”而不是把框挪回来：
                    // 框一旦被挪动，它就不在文字实际会落下的位置上了，恰恰把刚去掉底板
                    // 换来的“所见即所得”又破掉。限尺寸则位置不变，长内容自己滚。
                    // 宽度（方案 A）：默认一般长度 120px（min-width），随内容增长到选区右边界后
                    // 原生换行（wrap=soft），max-width 即“文字起点→选区右边界”封顶。
                    // 具体宽度在 autoSizeText 里按内容实测设置（不在 inline style 写死 width，
                    // 否则 React 重渲染会把已增长的宽度重置回初值）。
                    minWidth: availCss != null ? Math.min(120, availCss + TEXT_PAD * 2) : 120,
                    maxWidth: availCss != null ? availCss + TEXT_PAD * 2 : undefined,
                    maxHeight: Math.max(fontCss * TEXT_LINE_HEIGHT + TEXT_PAD * 2, screenBottom - css(textDraft.y) - 12),
                    // CSS 像素直接用 fontCss —— canvas 上是 fontCss × dpr 物理像素，
                    // 缩到 CSS 显示后正好等于 fontCss，两边视觉一致。
                    fontSize: fontCss,
                    lineHeight: TEXT_LINE_HEIGHT,
                    color,
                    // 描边要与画布同口径（draw.ts 的 text 分支：contrastInk 对比色描边，宽度 fs/8）。
                    // 旧实现只在 CSS 里写了一层黑色 text-shadow 去近似它 —— 选深色字（如黑）时
                    // 输入框里是「黑字 + 黑阴影」压在深色底上，几乎看不见自己在打什么；
                    // 而回车落字后画布给了浅色描边，又清晰了 —— 所见并非所得。
                    WebkitTextStrokeWidth: `${Math.max(1, fontCss / 10)}px`,
                    WebkitTextStrokeColor: contrastInk(color),
                    // 先描边后填色，与 canvas 的 stroke→fill 顺序一致，否则描边会把字身吃细
                    paintOrder: "stroke fill",
                  }}
                  // 快捷键说明移到下方工具条常驻（.tkeys）：放在 placeholder 里一打字就没了，
                  // 而用户恰恰是打到一半才想起来“怎么换行”。
                  placeholder="输入文字…"
                  onBlur={(e) => {
                    // 已通过 Enter 提交 / Esc 取消的，卸载时补发的 blur 不再提交（防双落 / 防取消却落字）。
                    if (textSubmittedRef.current) {
                      textSubmittedRef.current = false;
                      return;
                    }
                    submitText(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    // Enter（非 Shift、非输入法组合）提交；Shift+Enter 放行默认行为 = 换行。
                    // 阻断冒泡：否则 Enter 触发全局"完成标注"、Esc 关闭截图窗口（V3 bug）。
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.stopPropagation();
                      submitText((e.target as HTMLTextAreaElement).value);
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      // 取消：标记已处理，卸载时的 blur 不再把当前文字提交出去（否则"取消却落字"）。
                      textSubmittedRef.current = true;
                      setTextDraft(null);
                    }
                  }}
                />
                <TextToolbar
                  color={color}
                  onSelectColor={(c) => setColor(c)}
                  textSizeId={textSizeId}
                  onSelectTextSize={(id) => setTextSizeId(id)}
                  // 紧贴输入框下沿；贴底时翻到输入框上方（top 取负数偏移）。
                  // 三处都减 TEXT_PAD：输入框已经整体向左上偏了 TEXT_PAD，
                  // 工具条要跟的是框的**视觉边界**，不是文字的起点。
                  style={{
                    left: textDraft.x / dpr - TEXT_PAD,
                    top: flip
                      ? textDraft.y / dpr - TEXT_PAD - TOOLBAR_H - 6
                      : textDraft.y / dpr - TEXT_PAD + effBoxH + 6,
                  }}
                />
              </>
            );
          })()}
        </div>
      )}

      {/* 标注工具栏 */}
      {phase === "annotate" && sel && (
        <AnnotToolbar
          innerRef={tbRef}
          left={tbLayout.left}
          top={tbLayout.top}
          attach={tbLayout.attach}
          busy={busy}
          tool={tool}
          onSelectTool={onSelectTool}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          onUndo={undo}
          onRedo={redo}
          ocrStatus={ocrStatus}
          ocrLines={ocr?.lines.length ?? 0}
          ocrErr={ocrErr}
          ocrOpen={ocrDrawerOpen}
          onOcr={onOcrButton}
          hasAnnotations={annotations.length > 0}
          longShotting={longShot}
          onLongShot={() => void startLongShot()}
          aiOk={aiOk}
          onSave={() => void runExit("保存", saveImageTo)}
          onPin={() => {
            notePowerUsed("pin"); // B 方案：用过即停脉冲/教练卡
            void runExit("贴图", pinImageAt);
          }}
          onAi={onAiButton}
          // 写着"取消"就该是取消这次截图（微信同款）。
          // "退回选区"留给 Esc / 右键 —— 那两个才是"后退一步"的通用心智。
          onCancel={close}
          onDone={() => void copyImage()}
          onMore={() => void finish()}
          discover={discoverTools}
        />
      )}

      {/* OCR 选字模式胶囊：取代工具栏里的分段开关，锚定选区上缘右上角。
          点击在 智能意图 / Ctrl 间切换，读写走 get_config / save_config（与设置页同一份持久化值）。 */}
      {phase === "annotate" && sel && (
        <ModePill
          innerRef={pillRef}
          mode={ocrSelectMode}
          onToggle={() => changeOcrSelectMode(ocrSelectMode === "smart" ? "modifier" : "smart")}
          left={pillLayout.left}
          top={pillLayout.top}
        />
      )}

      {/* 属性条（双层的第二层）：只在绘制类工具选中时出现。
          属性记忆上次选择，所以实际不增加点击次数。 */}
      {phase === "annotate" && sel && showAttrBar && (
        <AttrBar
          left={tbLayout.left}
          top={tbLayout.attrTop}
          attach={tbLayout.attach}
          showColor={!NO_COLOR_TOOLS.has(tool)}
          color={color}
          onSelectColor={(c) => {
            setColor(c);
            // 吸管中改颜色 = 放弃取色，回到上一个绘制工具（否则选了色却还在取色态，画不了）
            if (tool === "picker") setTool(pickerPrevToolRef.current);
          }}
          pickerOn={tool === "picker"}
          onPicker={() => {
            // 吸管激活时记住上一个工具（点画布取色后自动恢复）——
            // 这段留在父组件，子组件不必知道 pickerPrevToolRef 的存在
            if (tool === "picker") {
              setTool(pickerPrevToolRef.current);
            } else {
              pickerPrevToolRef.current = tool;
              setTool("picker");
            }
          }}
          showWidth={WIDTH_TOOLS.has(tool)}
          widthId={widthId}
          onSelectWidth={setWidthId}
          showArrow={tool === "arrow"}
          arrowStyle={arrowStyle}
          onSelectArrowStyle={setArrowStyle}
          maskShape={tool === "dewarp" ? (dewarpMode === "manual" ? maskShape : undefined) : SHAPE_TOOLS.has(tool) ? maskShape : undefined}
          // 魔棒是去水印专属渲染路径（泛洪吸附 + inpaint）；马赛克/模糊选了也只会退化成矩形
          magicSupported={tool === "dewarp"}
          onSelectMaskShape={
            SHAPE_TOOLS.has(tool)
              ? (sp) => setMaskShapes((m) => ({ ...m, [tool]: sp }))
              : undefined
          }
          dewarpMode={tool === "dewarp" ? dewarpMode : undefined}
          onSelectDewarpMode={tool === "dewarp" ? setDewarpMode : undefined}
          onAutoDewarp={
            tool === "dewarp"
              ? () => {
                  setMaskApplyMode("dewarp");
                  void runAutoDewarp();
                }
              : undefined
          }
          // 马赛克「模式」分段：马赛克 / 模糊 / 自动打码 收进同一工具。
          //   - tool 为 mosaic / blur 时显示，高亮复用 tool 本身；
          //   - 自动打码预览打开期间强制保持可见（确认条锚点不因切工具消失）。
          // onSelectMaskMode 直接复用 onSelectTool：马赛克/模糊=setTool，自动打码=动作。
          maskMode={
            tool === "mosaic" || tool === "blur" || maskPreview !== null
              ? tool === "mosaic" || tool === "blur"
                ? tool
                : "mosaic"
              : undefined
          }
          onSelectMaskMode={onSelectTool}
          discoverAutomask={discoverTools.includes("automask")}
          maskOn={maskPreview !== null}
          maskActive={maskPreview?.filter((b) => !b.excluded).length ?? 0}
          onApplyMasks={maskApplyMode === "dewarp" ? applyDewarpMasks : applyMasks}
          onCancelMasks={() => {
            setMaskPreview(null);
            maskPreviewRef.current = null;
            // 取消时回到默认遮蔽语义，避免残留的 "dewarp" 影响下一次预览确认
            setMaskApplyMode("mosaic");
          }}
          textSizeId={TEXT_SIZE_TOOLS.has(tool) ? textSizeId : undefined}
          onSelectTextSize={TEXT_SIZE_TOOLS.has(tool) ? setTextSizeId : undefined}
          strengthLevels={
            tool === "mosaic"
              ? MOSAIC_LEVELS
              : tool === "blur"
                ? BLUR_LEVELS
                : tool === "dewarp"
                  ? DEWARP_LEVELS
                  : undefined
          }
          strengthValue={
            tool === "mosaic"
              ? mosaicStrength
              : tool === "blur"
                ? blurStrength
                : tool === "dewarp"
                  ? dewarpStrength
                  : undefined
          }
          onSelectStrength={
            tool === "mosaic"
              ? setMosaicStrength
              : tool === "blur"
                ? setBlurStrength
                : tool === "dewarp"
                  ? setDewarpStrength
                  : undefined
          }
        />
      )}

      {/* 出口反馈：成功与失败都要看得见（规则 15.3） */}
      {shotToast && (
        <div className={`shot-toast${shotToast.ok ? " ok" : ""}`}>
          <span className="ic">{shotToast.ok ? "✓" : "⚠"}</span>
          <span>{shotToast.text}</span>
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
        <div className="picker-bar" style={{ borderColor: "color-mix(in srgb, var(--accent, #3B9EFF) 45%, transparent)" }}>
          <span>{strengthHint}</span>
        </div>
      )}
      {/* A 方案：完成复制后的文字 toast（点击复制全文） */}
      {ocrToast && (
        <div
          className="picker-bar"
          style={{ cursor: "pointer", borderColor: "color-mix(in srgb, var(--green, #22c55e) 55%, transparent)", bottom: 64 }}
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

      {/* OCR 过程可见全部收到工具栏「取文字」按钮上：
            识别中 = 按钮图标变转圈（.ocr-spin），完成 = 行数角标，失败 = 感叹号角标。

          ❌ 原来还有一个浮动胶囊（.ocr-pill「识别文字中…」），于是同一件事**两处转圈**。
          删胶囊而不是删按钮上的：反馈应该贴在触发它的入口旁边（视线不用跑），
          而且完成态/失败态的胶囊早就因为同一理由删掉了——只剩下「识别中」这一个
          状态还另起一套展示，本身就是没改完的尾巴。 */}

      {/* OCR 结果抽屉 */}
      {(phase === "result" || ocrDrawerOpen) && ocr && (
        <OcrDrawer
          left={panelLayout.left}
          top={panelLayout.top}
          maxHeight={panelLayout.maxHeight}
          side={panelLayout.side}
          ocr={ocr}
          qr={qr}
          qrCopied={qrCopied}
          copiedAll={copiedAll}
          copiedRow={copiedRow}
          aiOk={aiOk}
          onCopyAll={() => void copyAllText()}
          onCopyRow={(i) => void copyRow(i)}
          onCopyQr={() => {
            if (!qr) return;
            void copyText(qr);
            setQrCopied(true);
            setTimeout(() => setQrCopied(false), 1200);
          }}
          onOpenQrUrl={() => {
            if (!qr) return;
            void invoke("open_url", { url: qr }).catch((e) => logger.warn("打开链接失败", e));
          }}
          onOpenOcrEdit={openOcrEdit}
          onOpenTable={openTable}
          onOpenAi={() => void openAi()}
          onOpenChains={() => void openChains()}
          onClose={close}
        />
      )}

      {/* V4：表格识别结果弹层 */}
      {tableOpen && (
        <TablePopover
          csv={tableCsv}
          err={tableErr}
          copied={tableCopied}
          onCopy={() => void copyTableCsv()}
          onClose={() => setTableOpen(false)}
        />
      )}

      {/* V6.19：OCR 文本编辑弹层（改错字再复制） */}
      {ocrEditOpen && (
        <OcrEditPopover
          text={ocrEditText}
          onChange={setOcrEditText}
          copied={ocrEditCopied}
          onCopy={() => void copyOcrEdited()}
          onClose={() => setOcrEditOpen(false)}
        />
      )}

      {/* 结果动作面板 */}
      {phase === "result" && (
        <ResultActions
          innerRef={actRef}
          left={actLayout.left}
          top={actLayout.top}
          attach={actLayout.attach}
          sensitiveKind={sensitiveKind}
          aiOk={aiOk}
          hasFixedRegion={hasFixedRegion}
          regionSaved={regionSaved}
          editorTarget={editorTarget}
          onCopyImage={() => void copyImage()}
          onSaveToGallery={() => void runExit("保存", saveImageTo)}
          onPinImage={() => void runExit("贴图", pinImageAt)}
          onOpenAi={() => void openAi()}
          onTranslate={() => void translateShot()}
          onOpenChains={() => void openChains()}
          onToggleRegion={hasFixedRegion ? clearRegion : saveRegion}
          onReselect={reselect}
          onInsertToEditor={() => void insertToEditor()}
        />
      )}

      {/* 贴图「预览即钉」：完成态半透明浮动预览，拖动到目标位置、松手/钉住即钉；Esc/取消=不钉 */}
      {phase === "result" && pinPreview && pinPreviewUrl && (
        <div
          className="pin-float"
          style={{ left: pinPreview.x, top: pinPreview.y }}
          onMouseDown={onPinFloatDown}
        >
          <div className="pin-float-bar">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void (async () => {
                  const path = resultPath;
                  if (!path) return;
                  setPinPreview(null);
                  pinPreviewRef.current = null;
                  await pinImageAt(path); // 内部会 close 截图窗
                })();
              }}
            >
              📌 钉住
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPinPreview(null);
                pinPreviewRef.current = null;
              }}
            >
              ✕ 取消
            </button>
          </div>
          <img className="pin-float-img" src={pinPreviewUrl} alt="截图预览" />
        </div>
      )}

      {/* ===== V2：AI 处理弹层 ===== */}
      {aiOpen && (
        <AiPopover
          hasText={!!ocrText()}
          res={aiRes}
          actions={aiActions}
          busyId={aiBusyId}
          copied={copiedOut}
          onRun={(a) => void runAiAction(a)}
          onContinue={() => {
            const a = lastAiActionRef.current;
            if (a) void runAiAction(a, true);
          }}
          onCopy={() => void copyAiResult()}
          onClose={closeAi}
        />
      )}

      {/* ===== V2：送动作链弹层 ===== */}
      {chainOpen && (
        <ChainPopover
          hasText={!!ocrText()}
          chains={chains}
          res={chainRes}
          err={chainErr}
          busyId={chainBusyId}
          copied={copiedOut}
          aiOk={aiOk}
          onRun={(c) => void runChainAction(c)}
          onCopy={() => void copyChainFinal()}
          onClose={closeChains}
        />
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
