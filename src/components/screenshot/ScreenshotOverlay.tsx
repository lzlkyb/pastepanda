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
import { emit, listen } from "@tauri-apps/api/event";
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
import { CHANGELOG } from "@/lib/changelog.generated";
import { compareVersions, getLastSeenVersion } from "@/lib/changelog";
import type { NewHint } from "./AnnotToolbar";
import { TooltipLayer } from "./TooltipLayer";
// 纯计算已抽到 lib/screenshot/（规则 7）——那里才能写回归测试：
// 坐标换算与磁吸曾各藏过一个真 bug，长截图重叠匹配曾把 G/B 通道索引写错。
import {
  applyMagnet,
  clampRect,
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
import {
  contrastInk,
  drawAnnot,
  inDrawOrder,
  measureTextExtent,
  TEXT_LINE_HEIGHT,
  wrapLines,
} from "@/lib/screenshot/draw";
import { isRowMasked } from "@/lib/screenshot/maskGeom";
import {
  findOverlapRows,
  findStickyTop,
  framesAlike,
  drawFeathered,
  cropWhiteMargins,
} from "@/lib/screenshot/stitch";
import { layoutToolbar, modePillPos } from "@/lib/screenshot/toolbarPos";
import { layoutOcrCopyBar } from "@/lib/screenshot/ocrBarPos";
import {
  pointInAnyWord,
  shouldStartOcrSelect,
  selectSpan,
  selectLine,
} from "@/lib/screenshot/ocrSelect";
import { lineBox } from "@/lib/screenshot/ocrTable";
import { findPrivateSpans } from "@/lib/screenshot/privacy";
import { layoutSidePanel } from "@/lib/screenshot/panelPos";
import { layoutSizeLabel } from "@/lib/screenshot/sizeLabelPos";
import type { OcrSelectMode } from "@/lib/screenshot/types";
import {
  LONGSHOT_CONTROL,
  LONGSHOT_PROGRESS,
  type LongShotControl,
  type LongShotProgress,
} from "@/lib/screenshot/longshotEvents";

/**
 * 后端 get_scroll_range 返回的可滚动控件范围（见 screenshot.rs）。
 *
 * ❌ n_max / n_page / n_pos 是**滚动单位**，不是像素：编辑框按行、列表按项。
 * 算预览几何只能用无单位的 extra_ratio（下方还有几屏）。
 */
interface ScrollRangeOut {
  x: number;
  y: number;
  w: number;
  h: number;
  n_max: number;
  n_page: number;
  n_pos: number;
  /** 光标下方还有几屏内容（无单位）。乘选区高度 = 要伸展的物理像素 */
  extra_ratio: number;
}
/** 自动打码「预览式」：OCR 命中的隐私框（相对选区局部坐标），excluded=用户点掉不参与打码 */
interface MaskBox {
  x: number;
  y: number;
  x2: number;
  y2: number;
  excluded: boolean;
}
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
import { BLUR_LEVELS, COLORS, MOSAIC_LEVELS, TEXT_SIZES, TOOL_BY_KEY, WIDTHS } from "./tools";
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
/* 放大镜参数（物理像素）：采样半径 30px，4 倍放大 → 240×240 画布 */
const MAG_R = 30;
const MAG_ZOOM = 4;
const MAG_SIZE = MAG_R * 2 * MAG_ZOOM;
/* 取色探针 canvas（模块级复用，避免拖选高频 GC） */
let probeCanvas: HTMLCanvasElement | null = null;

let idSeq = 1;
const nextId = () => idSeq++;

/* ===== 路线 C · 新功能提示（截图工具栏 NEW 角标 + 富教练卡） =====
 * 仅对「本版本新增且用户未用过 / 未看」的入口挂 NEW 角标并浮富教练卡。
 * 版本门控：用户 lastSeen 存在且早于最新版本（即升级过来的用户）才提示，
 * 老用户早已用过的功能不再唠叨。教练卡关闭即标记已看，下次不再出现。 */
const NEW_HINT_CONTENT: Record<string, NewHint> = {
  ocr: {
    id: "ocr",
    title: "取文字",
    why: "截图里看到字，点一下直接识别，不用先保存再翻菜单",
    how: ["点工具栏「取文字」按钮", "完成后自动展开文字，可逐行 / 逐字复制", "按 T 直接复制全文"],
    media: "ocr",
  },
  mosaic: {
    id: "mosaic",
    title: "马赛克 / 模糊「涂」",
    why: "像笔一样抹过去就打码，来回抹无缝拼接",
    how: ["选马赛克 / 模糊工具，按住拖动涂抹", "滚轮调强度"],
    media: "mosaic",
  },
  eraser: {
    id: "eraser",
    title: "真正的橡皮擦",
    why: "擦到笔迹会切成多段，而不是整条曲线全没",
    how: ["选橡皮擦工具，在要擦的笔迹上涂抹"],
    media: "eraser",
  },
};

const NH_SEEN_KEY = "pp_newhints_seen";
function readNewHintSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(NH_SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function writeNewHintSeen(s: Set<string>) {
  try {
    localStorage.setItem(NH_SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
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
  // 长截图「预览即默认」：进长截图前显示整页淡预览，单击截整页 / 拖拽选终点
  const [longPreview, setLongPreview] = useState(false);
  const longPreviewRef = useRef(false);
  const [previewRect, setPreviewRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewEndY, setPreviewEndY] = useState<number | null>(null); // 物理屏幕像素：终点手柄位置
  const previewDragRef = useRef(false);
  const previewMovedRef = useRef(false);
  // 固定区域「预览即默认」（P1）：恢复固定区域不再静默进标注，改用虚线紫框预览（单击采纳 / 拖改 / Esc 重置）
  const [fixedPreview, setFixedPreview] = useState(false);
  const fixedPreviewRef = useRef(false);
  // 自动打码「预览式」（P3）：检测后先橙色虚框轻预览，逐框可排除，确认才打马赛克
  const [maskPreview, setMaskPreview] = useState<MaskBox[] | null>(null);
  const maskPreviewRef = useRef<MaskBox[] | null>(null);
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
  /* 路线 C · 新功能教练卡「已看过」集合。
   * ❗ 必须留在组件顶部——下面的 `if (!screen) return …` 是个提前 return，
   *   hook 写到它后面会让首渲染（screen 为 null）少注册一个 hook，截屏拿到后
   *   setScreen 重渲染就多出一个，React 直接抛
   *   Rendered more hooks than during the previous render ——截图窗必崩。
   * 用 state 而非直读 localStorage：关掉教练卡要立即重渲染，否则卡片关不掉。 */
  const [seenHints, setSeenHints] = useState<Set<string>>(() => readNewHintSeen());
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
  // 常驻提示条：首次使用展示数次后自动淡出（持久化计数，手动 × 可提前关闭）
  const HINT_MAX_SHOWS = 5;
  const HINT_AUTO_FADE_MS = 9000;
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
  // 长截图滚动模式：auto = 软件自动滚动；manual = 用户自己滚、点「下一张」截帧。
  // 长截图进行中可由状态窗动态切换，主窗每轮滚动前读取本 ref。
  const modeLongRef = useRef<"auto" | "manual">("auto");
  // 手动模式：状态窗「下一张」置位，主循环 await waitUserScroll() 被唤醒截下一帧。
  const nextLongRef = useRef(false);
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
  // 放大镜（直接操作 DOM，避免拖选高频 setState 重渲染）
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magInfoRef = useRef<HTMLSpanElement | null>(null);
  const magVisibleRef = useRef(false);
  const magHexRef = useRef("#000000");

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
        if (longPreviewRef.current) {
          longPreviewRef.current = false;
          setLongPreview(false);
          return;
        }
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
      else if (e.payload === "next") nextLongRef.current = true; // 手动模式：截下一帧
      else if (e.payload === "mode_auto") modeLongRef.current = "auto";
      else if (e.payload === "mode_manual") modeLongRef.current = "manual";
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

  /* ===== 自动打码（P0）：OCR 定位隐私文本 → 批量矩形马赛克 ===== */

  /**
   * 确保已拿到选区 OCR 结果（复用「取文字」同一套管线：裁选区 → 存临时 PNG → ocrImage）。
   * - 已有结果直接返回（标注态进入时已提前 OCR，绝大多数情况走这里）；
   * - 否则现场跑一次（首屏未识别完就被点的兜底）。
   * 返回 null 表示识别不可用（图太小 / OCR 失败）。
   */
  const ensureRegionOcr = useCallback(async (): Promise<OcrResult | null> => {
    if (ocr && ocr.lines.length > 0) return ocr;
    const r = selRef.current;
    if (!r || r.w < 4 || r.h < 4 || !screen) return null;
    try {
      setOcrStatus("running");
      const img = await loadImage(screen.dataUrl);
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(r.w));
      out.height = Math.max(1, Math.round(r.h));
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
      // 必须走 canvasToDataUrl（toBlob）—— out.toDataURL 是**同步**全尺寸 PNG 编码，
      // 2560×1440 的选区就是几百毫秒主线程冻结，用户此时点工具栏就是“点了不反应”。
      const dataUrl = await canvasToDataUrl(out);
      const tmpPath = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
      void invoke("mark_ocr_temp", { path: tmpPath }).catch(() => {});
      const res = await ocrImage(tmpPath);
      setOcr(res);
      setOcrStatus(res.fullText?.trim() ? "done" : "empty");
      return res;
    } catch (e) {
      logger.warn("自动打码：OCR 失败", e);
      setOcrStatus("failed");
      return null;
    }
  }, [ocr, screen]);

  /**
   * 一键自动打码：对图中命中的隐私词逐词生成矩形马赛克元素（单次撤销整体可退）。
   * 文本正则（手机/身份证/邮箱/银行卡/QQ/微信号/IP/车牌/姓名[带标签]/地址[带标签]）+ 二维码/条码，不含人脸（P0 范围）。
   */
  const runAutoMask = useCallback(async () => {
    if (busy) return; // 合成/保存中不做
    const res = await ensureRegionOcr();
    if (!res) {
      showToast("自动打码失败：文字识别未就绪", false);
      return;
    }
    const r = selRef.current;
    const baseW = r ? Math.round(r.w) : 0;
    const baseH = r ? Math.round(r.h) : 0;
    const pad = 4; // 物理像素外扩，确保整词被盖住
    const boxes: MaskBox[] = [];
    for (const line of res.lines) {
      // 隐私判定用**整行文本**：手机号/身份证/邮箱都是整串正则，拿单个字符去匹配
      // 永远命中不了（若用 w.text 判，自动打码会 100%「未发现隐私」）。
      // 但打码范围只取**命中的那几个字**：
      // ❌ 旧实现命中就盖整行，「客服电话 13800138000 工作时间 9:00-18:00」
      // 会被整条涂黑，用户想留的内容一起没了。
      if (!line.text) continue;
      const spans = findPrivateSpans(line.text);
      if (spans.length === 0) continue;
      // words 有两种形态：逐字符（后端给了 char_xn）与整行单框（兼容回退）。
      // 只有逐字形态才能定位到子串；整行单框只能退回盖整行。
      const perChar = line.words.length === Array.from(line.text).length;
      const ranges = perChar
        ? spans.map((s) => [s.start, s.end] as const)
        : ([[0, line.words.length]] as const as readonly (readonly [number, number])[]);
      for (const [from, to] of ranges) {
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (let k = from; k < to; k++) {
          const w = line.words[k];
          if (!w) continue;
          x1 = Math.min(x1, w.x);
          y1 = Math.min(y1, w.y);
          x2 = Math.max(x2, w.x + w.width);
          y2 = Math.max(y2, w.y + w.height);
        }
        if (!Number.isFinite(x1)) continue;
        const x = Math.max(0, Math.round(x1) - pad);
        const y = Math.max(0, Math.round(y1) - pad);
        const xe = Math.min(baseW, Math.round(x2) + pad);
        const ye = Math.min(baseH, Math.round(y2) + pad);
        if (xe - x < 2 || ye - y < 2) continue;
        boxes.push({ x, y, x2: xe, y2: ye, excluded: false });
      }
    }
    // 二维码 / 条码：文本正则的盲区（DAMA/Snagit 都盖）。在选区位图上跑 jsQR，
    // 取 location 四角算包围盒加入预览——失败不阻断文本打码。
    try {
      if (screen && r && r.w >= 8 && r.h >= 8) {
        const img = await loadImage(screen.dataUrl);
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(r.w));
        cv.height = Math.max(1, Math.round(r.h));
        const cctx = cv.getContext("2d");
        if (cctx) {
          cctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
          const id = cctx.getImageData(0, 0, cv.width, cv.height);
          const jsQR = (await import("jsqr")).default;
          const qr = jsQR(id.data, cv.width, cv.height, { inversionAttempts: "dontInvert" });
          if (qr && qr.location) {
            const loc = qr.location;
            const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
            const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
            const qx = Math.max(0, Math.round(Math.min(...xs)) - pad);
            const qy = Math.max(0, Math.round(Math.min(...ys)) - pad);
            const qxe = Math.min(baseW, Math.round(Math.max(...xs)) + pad);
            const qye = Math.min(baseH, Math.round(Math.max(...ys)) + pad);
            if (qxe - qx >= 2 && qye - qy >= 2) {
              boxes.push({ x: qx, y: qy, x2: qxe, y2: qye, excluded: false });
            }
          }
        }
      }
    } catch (e) {
      logger.warn("自动打码：二维码识别失败（不影响文本打码）", e);
    }

    if (boxes.length === 0) {
      showToast("未发现可打码的隐私信息（手机/身份证/邮箱/银行卡/座机/姓名/地址等）", false);
      return;
    }
    // 预览式（P3）：先显示橙色虚框轻预览，逐框可排除，确认才打马赛克，避免误伤普通文字
    maskPreviewRef.current = boxes;
    setMaskPreview(boxes);
    showToast(`识别到 ${boxes.length} 处隐私 · 点框可排除 · 全部确认即打码`, true);
  }, [ensureRegionOcr, busy, showToast, screen]);

  /** 工具栏选工具：自动打码是动作型按钮，拦截后执行打码、不切换绘制工具。 */
  const onSelectTool = useCallback(
    (id: ToolId) => {
      if (id === "automask") {
        notePowerUsed("automask"); // B 方案：用过即停脉冲/教练卡
        void runAutoMask();
        return;
      }
      setTool(id);
    },
    [runAutoMask, notePowerUsed],
  );

  /* 自动打码「预览式」：点框切换排除 / 全部确认即打码（整批一次 undo） */
  const toggleMaskBox = useCallback((i: number) => {
    setMaskPreview((prev) => {
      if (!prev) return prev;
      const next = prev.map((b, idx) => (idx === i ? { ...b, excluded: !b.excluded } : b));
      maskPreviewRef.current = next;
      return next;
    });
  }, []);

  const applyMasks = useCallback(() => {
    const boxes = maskPreviewRef.current;
    if (!boxes) return;
    const active = boxes.filter((b) => !b.excluded);
    setMaskPreview(null);
    maskPreviewRef.current = null;
    if (active.length === 0) {
      showToast("已排除全部，未打码", false);
      return;
    }
    const els: Annotation[] = active.map((b) => ({
      id: nextId(),
      type: "mosaic",
      color: "",
      width: 0,
      x: b.x,
      y: b.y,
      x2: b.x2,
      y2: b.y2,
      strength: mosaicStrength,
      shape: "rect",
    }));
    // 整批一次入 undo，Ctrl+Z 一次性退回所有自动打码（不逐个占撤销栈）
    const prev = annotationsRef.current;
    setUndoStack((u) => [...u, prev]);
    setRedoStack([]);
    setAnnotations([...prev, ...els]);
    showToast(`已自动打码 ${els.length} 处`, true);
  }, [mosaicStrength, showToast]);

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
    // 与预览用同一个排序（否则会出现“预览看着对、导出的图不对”）
    for (const a of inDrawOrder(annotations)) drawAnnot(ctx, a, img, r.x, r.y);
    const { path } = await saveResultImage(out);
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
      showToast(`图片合成失败：${errText(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureResultPath, ocr, showToast]);

  /** 恢复截图窗 + 关状态窗 + 释放全局 Esc。幂等，可重复调用。
   *
   *  三个动作绑在一起是故意的 —— 它们必须同时发生，漏一个就会留下
   *  "状态窗还在 / Esc 被占 / 截图窗不见了"这类半死不活的状态。 */
  const restoreShotWindow = useCallback(async () => {
    await withTimeout(invoke("close_longshot_status"), 2000, "关闭状态窗").catch(() => undefined);
    const shown = await withTimeout(invoke("show_screenshot_window"), 2000, "恢复截图窗")
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      // 恢复不了就干脆关掉。留一个看不见却挡鼠标的全屏透明窗，
      // 比直接关闭糟糕得多 —— 后者至少用户能继续用电脑。
      logger.error("恢复截图窗失败，改为关闭窗口以免留下隐形覆盖层");
      void invoke("close_screenshot_window").catch(() => undefined);
    }
    setLongShot(false);
  }, []);

  /** V3：长截图（滚动拼接）。隐藏截图窗口 → 循环 截屏+匹配+滚轮 → 恢复窗口出结果 */
  const startLongShot = useCallback(async (captureBottomPx?: number) => {
    const r = selRef.current;
    if (!r || longShot || busy) return;
    abortLongRef.current = false;
    stopLongRef.current = false;
    escBurstRef.current = 0;
    modeLongRef.current = "auto";
    nextLongRef.current = false;
    setLongShot(true);
    let restored = false;
    try {
      // 逃生舱最先武装，而且独立于状态窗：状态窗创建失败时反而最需要它。
      // （上一版把注册写在 open_longshot_status 里且在 build() 之后，
      //   状态窗一失败就直接 return Err，全局 Esc 根本没注册上。）
      // 全局 Esc 是逃生舱第二道保险。注册失败（多见于 Esc 被别的程序全局占用）不再静默吞掉：
      // 状态窗已必现（pick_status_pos 兜底），用户仍能用“放弃”按钮退出，这里给出明确提示。
      const escOk = await withTimeout(invoke<boolean>("arm_longshot_escape"), 2000, "注册全局 Esc").catch(
        () => false,
      );
      if (!escOk) {
        logger.warn("长截图全局 Esc 注册失败，退出请用状态窗“放弃”按钮");
        showToast("全局 Esc 被占用，退出请用状态窗“放弃”按钮", true);
      }
      // 先开状态小窗再隐藏截图窗：小窗在选区外，不会被拼进长图；
      // 先开也能避免中间出现"屏幕上什么都没有"的空窗。
      // 返回 false = 选区占满屏幕、无处可放，本次无法中途停止（只能等跑完）。
      const [srx, sry] = toScreenPt(screen, r.x, r.y);
      const statusOk = await invoke<boolean>("open_longshot_status", {
        x: Math.round(srx),
        y: Math.round(sry),
        w: Math.max(1, Math.round(r.w)),
        h: Math.max(1, Math.round(r.h)),
      }).catch((e) => {
        logger.warn("长截图状态窗打开失败（不阻断长截图）", e);
        return false;
      });
      if (!statusOk) {
        logger.warn("未开长截图状态窗：选区无留白位置，本次不可中途停止");
        // 窗口马上要隐藏，先给用户看一眼再走（规则 15.3：不静默）。
        // 这是罕见路径（选区占满整块屏幕），多等 700ms 不影响正常使用。
        showToast("选区占满屏幕，本次长截图无法中途停止", true);
        await sleep(700);
      }
      await invoke("hide_screenshot_window");
      const pieces: HTMLCanvasElement[] = [];
      /** 与 pieces 同下标：该片顶部的羽化重叠行数（首片恒为 0）。
       *  合成时第 i 片画在 yy - fades[i]，累加则只加 height - fades[i]。 */
      const fades: number[] = [];
      let prevCanvas: HTMLCanvasElement | null = null;
      let totalH = 0;
      const MAX_STEPS = 20;
      const startedAt = Date.now();
      const MAX_H = 12000; // 浏览器 canvas 高度上限附近，防爆

      // 选区在屏幕坐标系的位置（循环里不变，算一次就行）
      const [rx, ry] = toScreenPt(screen, r.x, r.y);
      const rw = Math.max(1, Math.round(r.w));
      const rh = Math.max(1, Math.round(r.h));
      // 选区中心（滚动注入 + 查询滚动条到底都用屏幕坐标，算一次）
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;

      /** 抓一张缩小版选区，专用于判断画面是否已渲染稳定（只截选区后这一步很便宜） */
      const probe = async (): Promise<ImageData | null> => {
        try {
          const s = await withTimeout(
            invoke<ScreenInfo>("capture_region", { x: Math.round(rx), y: Math.round(ry), w: rw, h: rh }),
            LONG_IPC_TIMEOUT_MS,
            "采样截图",
          );
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

      /** 手动滚动模式：阻塞直到用户点状态窗「下一张」(next) 或 中止/停止。
       *  期间用户用鼠标自行向下滚动目标窗口，点「下一张」后主窗截当前画面拼上。
       *  轮询而非阻塞等待，确保 abort/stop 能立即唤醒退出。 */
      const waitUserScroll = () => new Promise<void>((resolve) => {
        const check = () => {
          if (nextLongRef.current) {
            nextLongRef.current = false;
            resolve();
          } else if (abortLongRef.current || stopLongRef.current) {
            resolve();
          } else {
            setTimeout(check, 120);
          }
        };
        check();
      });

      // 部分应用不响应 PostMessage 滚轮，发现画面没动时切到 SendInput 重试一次
      let wheelForceInput = false;

      /** 向选区中心注入一次向下滚轮（坐标要屏幕坐标系） */
      const scrollOnce = async () => {
        await withTimeout(
          invoke("scroll_longshot", {
            x: Math.round(cx),
            y: Math.round(cy),
            delta: -120,
            forceInput: wheelForceInput,
          }),
          LONG_IPC_TIMEOUT_MS,
          "滚动注入",
        );
      };

      /** P1：查询选区命中的可滚动控件是否已滚到底（权威终止信号）。
       *  无 WS_VSCROLL 子控件（浏览器等）→ 返回 false，交给图像重叠兜底。 */
      const getScrollBottom = () =>
        withTimeout(invoke<boolean>("get_scroll_bottom", { x: Math.round(cx), y: Math.round(cy) }),
          LONG_IPC_TIMEOUT_MS,
          "查询滚动条到底",
        ).catch(() => false);

      // stopLongRef 也要进循环条件：它表示"停下来但要出图"，与 abort 走同一个出口但结果相反
      for (let i = 0; i < MAX_STEPS && !abortLongRef.current && !stopLongRef.current; i++) {
        // 只截选区，不再截全屏再裁。原实现每帧跑一遍
        // 「全屏 BitBlt → BGRA→RGBA → RGB8 → JPEG 编码 → base64 → IPC → Image 解码 → drawImage 裁出选区」，
        // 最后一步才把大部分像素丢掉——选区占屏 1/5 就有 80% 是白做的，而这要跑最多 40 遍。
        // 总时长上限：超了就当作"停止并出图"，已拼的内容不浪费。
        // 不能让用户对着一个隐藏的窗口干等几十秒。
        // ❌ 总时长上限**只管自动模式**。它的立论是「窗口隐藏着、用户只能干等」，
        // 而手动模式下用户正在亲自滑、亲自点「下一张」——一屏 3~8 秒，25 秒才四五屏
        // 就会被静默 break，人还在滑，截图已经结束了。手动模式的终止权在用户
        // （stop / abort）与 MAX_STEPS，不在墙钟。
        if (
          (modeLongRef.current as "auto" | "manual") === "auto" &&
          Date.now() - startedAt > LONG_DEADLINE_MS
        ) {
          logger.warn(`长截图达到总时长上限 ${LONG_DEADLINE_MS}ms，按停止处理`);
          break;
        }
        const shot = await withTimeout(
          invoke<ScreenInfo>("capture_region", { x: Math.round(rx), y: Math.round(ry), w: rw, h: rh }),
          LONG_IPC_TIMEOUT_MS,
          "区域截图",
        );
        const img = await loadImage(shot.dataUrl);
        const piece = document.createElement("canvas");
        piece.width = Math.max(1, Math.round(r.w));
        piece.height = Math.max(1, Math.round(r.h));
        const pctx = piece.getContext("2d");
        if (!pctx) break;
        // 返回的已经就是选区尺寸，直接画，不再需要源矩形参数
        pctx.drawImage(img, 0, 0);
        // P2-B2 统一 DPI：每片按物理像素截（grab_rect_rgba 用屏幕 DC），画布锁死到选区标称尺寸，
        // 任何 DPI 取整/缩放偏差都被 drawImage(0,0) 拉伸归一，保证所有 piece 同一比例。
        // 若原生截图像素数与标称不符（混合 DPI 跨屏的典型征兆），记日志便于排查，不阻断拼接。
        // ⚠️ 已知限制：本归一仅保证「每片同比例」，无法修正跨显示器选区因 BitBlt 跨屏原点偏移
        // 造成的坐标错位（混合 DPI 多显示器）。根治需按显示器分块截取再拼合，本次未做。
        if (img.naturalWidth !== piece.width || img.naturalHeight !== piece.height) {
          logger.warn(
            `[长截图] 截得 ${img.naturalWidth}x${img.naturalHeight} 与选区 ${piece.width}x${piece.height} 不符（疑混合 DPI），已归一`,
          );
        }

        let append: HTMLCanvasElement;
        let visible = piece.height;
        /** 本片顶部留给羽化的重叠行数（首帧为 0）；合成时要往上叠回这么多。 */
        let fade = 0;
        if (prevCanvas) {
          // P2-A1：检测吸顶带（固定导航/表头），拼接时跳过，避免重复带 + seam 错位
          const sticky = findStickyTop(prevCanvas, piece, piece.width, piece.height);
          const overlap = findOverlapRows(prevCanvas, piece, piece.width, piece.height, sticky);
          if (overlap <= 2) {
            // 手动模式：用户点「下一张」时画面没变化（没滚或滚得极少）→ 提示，不推进不退出，
            // 等待用户真正滚动后再点「下一张」；不消耗终止逻辑（终止由用户 stop/abort 控制）。
            if ((modeLongRef.current as "auto" | "manual") === "manual") {
              showToast("画面没变化：请先向下滚动目标窗口，再点『下一张』", false);
              // ❌ 必须先等用户再点一次「下一张」再回到循环顶部。
              // 直接 continue 会跳过循环底部的 waitUserScroll，变成无等待自旋：
              // 截图→还是没变→弹提示→再截……几秒内刷完 MAX_STEPS，长截图自己结束了。
              await waitUserScroll();
              await waitStable();
              continue;
            }
            // 自动模式：画面没动 = 真到底 或 滚轮不被接受。
            // 还没试过 SendInput 就先切过去重滚一次，别把「注入方式不被接受」误判成「已到底」。
            if (!wheelForceInput) {
              wheelForceInput = true;
              logger.info("[长截图] PostMessage 滚轮似乎无效，回退 SendInput 重试");
              await scrollOnce();
              await waitStable();
              continue; // 本帧不计入，重新截一帧再判
            }
            // 已用 SendInput 仍不动：区分「滚到底」与「根本不滚」。
            // pieces 只拼了一屏（首屏）就不动 → 目标窗口不响应滚动，大概率不是长页面。
            if (pieces.length <= 1) {
              showToast("该区域不响应滚动，可能不是长页面", false);
            }
            break; // 真到底 / 不滚动，停止
          }
          // seam = 吸顶带 + 重叠行：append 从 seam 开始取，吸顶带被剔除（P2-A1）
          const seam = sticky + overlap;
          if (piece.height - seam <= 0) break;
          // P2-B1 羽化：多往上取 fade 行。这 fade 行与上一片末尾是**同一内容**（它们本就在
          // 重叠区里），合成时往上叠回去做 alpha 交叉淡化。不留这几行就没东西可淡化——
          // 旧实现把斜坡贴在空白区上，反而每条接缝多出一条半透明带。
          fade = Math.min(LONG_FEATHER, seam);
          visible = piece.height - seam + fade;
          append = document.createElement("canvas");
          append.width = piece.width;
          append.height = visible;
          append
            .getContext("2d")!
            .drawImage(piece, 0, seam - fade, piece.width, visible, 0, 0, piece.width, visible);
        } else {
          append = piece;
        }
        // 新增高度不算那 fade 行（它们叠在上一片上，不占高）
        const grow = visible - fade;
        if (totalH + grow > MAX_H) break;
        pieces.push(append);
        fades.push(fade);
        totalH += grow;
        prevCanvas = piece;
        // 上报进度给状态小窗（截图窗自己已经隐藏，这是唯一看得见的地方）
        void emit(LONGSHOT_PROGRESS, {
          frames: pieces.length,
          height: totalH,
          thumb: thumbOf(piece),
        } satisfies LongShotProgress);

        // 预览即默认：拖拽选终点 → 截到 captureBottomPx 为止（裁末帧底部，与 get_scroll_bottom 双保险）
        if (captureBottomPx != null && totalH > captureBottomPx) {
          const over = totalH - captureBottomPx;
          const last = pieces[pieces.length - 1];
          const c = document.createElement("canvas");
          c.width = last.width;
          c.height = Math.max(1, last.height - over);
          c.getContext("2d")!.drawImage(last, 0, 0);
          pieces[pieces.length - 1] = c;
          totalH -= over;
          break;
        }

        // 自动模式：先查滚动条是否到底（P1 权威信号）。已到底 → 当前帧已是最后一屏，直接停，
        // 不浪费一次"滚了却没动"的无用帧。没到底 → 注入滚动（WM_VSCROLL 优先 → 滚轮回退）后等稳定。
        // 手动模式：不自动滚动，等用户自己向下滚动并点状态窗「下一张」，再等稳定。
        if ((modeLongRef.current as "auto" | "manual") === "manual") {
          await waitUserScroll();
          await waitStable();
        } else {
          const atBottom = await getScrollBottom();
          if (atBottom) {
            logger.info("[长截图] 滚动条已到底，停止（权威终止）");
            break;
          }
          await scrollOnce();
          await waitStable();
        }
      }
      // 滚动阶段到此结束 —— 立刻把界面还给用户，不要让后面的合成/OCR 拖着窗口不放。
      // 旧顺序是"拼接 + 合成 + OCR 全跑完 → finally 才 show"，
      // 而长图 OCR 几十秒起步，用户看到的就是"点了长截图一直等，什么都没有"。
      await restoreShotWindow();
      restored = true;

      // Esc 中止，或一帧都没成功 → 不出图。
      // 原实现 abortLongRef 只跟出循环，后面照样拼接 + finalizeCanvas + 进 result 态，
      // 用户按 Esc 想取消，却得到一张半截图（违反规则 17.6 两级取消）；
      // pieces 为空时 totalH=0，还会存一张 1px 高的垃圾图。
      if (abortLongRef.current || pieces.length === 0) {
        logger.warn(
          `长截图未出图（${abortLongRef.current ? "用户中止" : "未捕获到内容"}），保持当前状态`,
        );
        // 窗口隐藏了好几秒又原样回来，不说一声就是"点了长截图什么都没发生"（规则 15.3）
        showToast(
          abortLongRef.current ? "已放弃长截图" : "长截图未捕获到内容 · 该窗口可能不响应滚轮",
          abortLongRef.current,
        );
        return; // finally 里会恢复窗口并清 longShot
      }
      // 拼接长图
      const long = document.createElement("canvas");
      long.width = Math.max(1, Math.round(r.w));
      long.height = Math.max(1, totalH);
      const lctx = long.getContext("2d");
      if (lctx) {
        // yy = 本片**新内容**的起始行。续接帧顶部那 fades[i] 行是与上一片末尾重复的
        // 内容，所以要画在 yy - fade 处、且不计入高度——同一内容互相淡入才叫交叉淡化。
        let yy = 0;
        for (let i = 0; i < pieces.length; i++) {
          const p = pieces[i];
          const fade = fades[i] ?? 0;
          if (i > 0 && fade > 0) drawFeathered(lctx, p, yy - fade, fade);
          else lctx.drawImage(p, 0, yy);
          yy += p.height - fade;
        }
        // P2-A2：去掉四周全白留白（选区比窗口略大带入的桌面白边），内容内白区不动
        const out = cropWhiteMargins(long);
        // 界面已经回来了，用 busy 态告诉用户还在处理（工具栏变淡 + "处理中…"）。
        // busy 不拦 Esc，所以这段时间用户随时可以退出。
        setBusy(true);
        try {
          await finalizeCanvas(out);
        } finally {
          setBusy(false);
        }
      }
    } catch (err) {
      logger.error("长截图失败", err);
      showToast(`长截图失败：${errText(err)}`);
    } finally {
      // 正常路径已经在循环结束后恢复过了；这里只兜异常路径（循环中途抛错）。
      if (!restored) await restoreShotWindow();
    }
    // screen 入依赖：滚轮注入要把选区中心换成屏幕坐标，依赖 screen.originX/Y
  }, [longShot, busy, finalizeCanvas, screen, showToast, restoreShotWindow]);

  /** 长截图入口（微信思维）：先探测选区命中的可滚动控件，命中有滚动条且页面明显更长
   *  则显示整页淡预览（窗口不隐藏）；否则直接走原有自动滚动（浏览器/SPA 无 Win32 滚动条时零回归）。 */
  const onLongShotPreview = useCallback(async () => {
    const r = selRef.current;
    if (!r || !screen || longShot || busy) return;
    // 探测用绝对屏幕坐标（同 get_scroll_bottom 的写法）
    const [cx, cy] = toScreenPt(screen, r.x + r.w / 2, r.y + r.h / 2);
    const range = await invoke<ScrollRangeOut | null>("get_scroll_range", {
      x: Math.round(cx),
      y: Math.round(cy),
    }).catch(() => null);
    if (!range) {
      void startLongShot();
      return;
    }
    // ❌ 下方剩多少只能用比例算：旧实现直接拿 (n_max - n_page - n_pos) 当物理像素，
    // 而记事本类控件按**行**计、列表按**项**计——一个 1000 行的文档会被当成 1000px，
    // 于是预览框高度、“整页 ≈ Npx”、“约 N 屏”全错；而拖终点又是从这套错几何
    // 算出 captureBottomPx，会导致提前截断。extra_ratio 是无单位的，乘选区高度就对了。
    const extraBelow = Math.max(0, Math.round(range.extra_ratio * r.h));
    // 页面没明显更长（不足半屏）就不做预览，直接截整页
    if (range.extra_ratio < 0.5) {
      void startLongShot();
      return;
    }
    const top = r.y;
    const maxH = screen.height - top;
    const h = Math.min(maxH, r.h + extraBelow);
    setPreviewRect({ x: r.x, y: top, w: r.w, h });
    const screens = Math.max(2, Math.round(1 + range.extra_ratio));
    setPreviewLabel(`整页约 ${screens} 屏`);
    setPreviewEndY(top + h); // 默认拖到整页底部
    longPreviewRef.current = true;
    setLongPreview(true);
  }, [longShot, busy, startLongShot, screen]);

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

  /** 另存为图片文件。path 由 runExit 给，本函数不碰 resultPath。 */
  const saveImageTo = async (path: string) => {
    const dest = await save({
      defaultPath: `PastePanda-截图-${Date.now()}.png`,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] }],
    });
    if (!dest) return; // 用户取消：不报错也不关窗
    await invoke("save_image_file", { source: path, dest });
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
    const isBrush = SHAPE_TOOLS.has(tool) && maskShape === "brush";
    const a: Annotation = {
      id: nextId(),
      type: tool,
      color,
      width: lineW,
      x: px,
      y: py,
      x2: px,
      y2: py,
      points: tool === "pen" || isBrush ? [[px, py]] : undefined,
      text: tool === "number" ? String(nextNumber()) : undefined,
      size: tool === "number" ? fontPx : undefined,
      arrowStyle: tool === "arrow" ? arrowStyle : undefined,
      strength: tool === "mosaic" ? mosaicStrength : tool === "blur" ? blurStrength : undefined,
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
    setSnapWin(null); // 点选即退出 hover 吸附态的窗口轮廓（拖选固定后不再显示双层）
    kbActiveRef.current = false; // 拖选/点选退出键盘遍历态
    if (longPreview) return; // 预览态：预览层自行处理单击/拖拽，不触发框选
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
    setSelDraft({ x: px, y: py, w: 0, h: 0 });
  };
  const onSelectMouseMove = (e: React.MouseEvent) => {
    if (longPreview) return;
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
      setSelDraft(draft);
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
    // 先取引用并立刻清空，确保任何提前返回路径（含 longPreview 分支）都不会留下悬挂 dragRef。
    const d = dragRef.current;
    dragRef.current = null;
    if (longPreview) return;
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
    if (w >= 4 && h >= 4) {
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
    if (longPreview) return;
    if (!screen) return;
    selFixedRef.current = true;
    if (selRef.current) {
      setPhase("annotate");
      return;
    }
    setSel({ x: 0, y: 0, w: screen.width, h: screen.height });
    setPhase("annotate");
  };

  /* 长截图「预览即默认」：预览层交互。窗口可见、不隐藏，单击=截整页 / 拖青线=截到该处 */
  const commitLongShot = (captureBottomPx?: number) => {
    longPreviewRef.current = false;
    setLongPreview(false);
    void startLongShot(captureBottomPx);
  };
  // ❌ 拖拽必须挂 window 监听，不能只用元素上的 React onMouseMove/onMouseUp：
  // 用户往下拖选终点时很容易拖出预览框，一出框就收不到 move/up，
  // 拖拽态卡住、这一次拖拽直接丢失。同文件里其它拖拽（把手缩放、贴图浮动
  // 预览、OCR 拖选）都是 window 级，这里保持一致。
  const onPreviewDown = (e: React.MouseEvent) => {
    if (!longPreview || !previewRect) return;
    e.stopPropagation();
    previewDragRef.current = true;
    previewMovedRef.current = false;
    const startEnd = previewEndY;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const toAbsY = (clientY: number) => (clientY - rect.top) * dpr + previewRect.y;
    let latest = startEnd;

    const onMove = (ev: MouseEvent) => {
      const rb = selRef.current;
      const minY = rb ? rb.y + rb.h : previewRect.y;
      const maxY = previewRect.y + previewRect.h;
      const clamped = Math.max(minY, Math.min(maxY, toAbsY(ev.clientY)));
      if (startEnd != null && Math.abs(clamped - startEnd) > 4 * dpr) previewMovedRef.current = true;
      latest = clamped;
      setPreviewEndY(clamped);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!previewDragRef.current) return;
      previewDragRef.current = false;
      const rb = selRef.current;
      if (previewMovedRef.current && rb && latest != null) {
        // 拖拽选终点：只截到终点为止
        commitLongShot(Math.max(rb.h, latest - rb.y));
      } else {
        // 单击 / 未拖动：截整页
        commitLongShot(undefined);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
    // 长截图淡预览态：整个画面归预览层管，画布不接手。
    // 预览是从标注态工具栏进的，phase 仍是 annotate，所以预览框**以外**的单击
    // 会落到这块画布上变成画标注，而提示写的是「单击=截整页」。
    // select 态四个 handler 都加了这道守卫，漏的就是这一个。
    if (longPreview) return;
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
    // 元素移动结束：入 undo
    if (annotMoveRef.current) {
      annotMoveRef.current = null;
      snapshotUndo();
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
        // 编辑已有文字：原地更新，并压 undo 快照（与 commitAnnot 一致）。
        const prev = annotationsRef.current;
        setUndoStack((u) => [...u, prev]);
        setRedoStack([]);
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
  // 显示选区：select 态取拖选草稿（橡皮筋）；标注/结果态**强制用真实选区 sel**——
  // selDraft 有两条提前 return 路径不清空（finalizeSelectDrag 的 longPreview / !d 分支），
  // 一旦残留，shade-block 蒙版 / 选区框 / 工具栏会按残留草稿切出 4 段蒙版（历史 bug）。
  const displaySel = phase === "select" ? (selDraft ?? sel) : sel;

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

  /* B 方案 · 引导计算：未用过的强力功能（自动打码 / 取文字 / 贴图）给一次性脉冲。 */
  const POWER_TOOLS = ["automask", "ocr", "pin"] as const;
  const discoverTools = POWER_TOOLS.filter((id) => !usedFeatures.has(id));

  /* 路线 C · 版本门控的新功能教练：
   * 仅当用户 lastSeen 早于最新版本（升级用户）或全新用户（无 lastSeen）时，
   * 才对新功能入口挂 NEW 角标 + 富教练卡；已看过的提示（pp_newhints_seen）不再浮现。
   * 与 B 方案的脉冲并存：脉冲靠 discoverTools，富卡靠 coachHint。 */
  const lastSeen = getLastSeenVersion();
  const latestVer = CHANGELOG[0]?.version ?? "";
  const showNewHints = !lastSeen || compareVersions(latestVer, lastSeen) > 0;
  // seenHints 的 useState 在组件顶部声明（这里已在 `if (!screen) return` 之后，
  // 放 hook 会直接拆掉 hook 顺序），此处只做纯推导。
  const newHints = showNewHints
    ? Object.values(NEW_HINT_CONTENT).filter((h) => !seenHints.has(h.id))
    : [];
  const coachHint = newHints[0] ?? null;
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

      {/* 常驻操作提示条：让原本「隐身」的吸附/键盘遍历能力对用户可见；首次使用后数秒自动淡出、累计展示若干次后排期退休 */}
      {hintVisible && (phase === "select" || phase === "annotate") && (
        <div className={`shot-hint${hintFading ? " fade-out" : ""}`}>
          {phase === "select" ? (
            <>
              <span><span className="hk">拖拽</span> 框选 · 松手自动标注</span>
              <span className="sep" />
              <span><span className="hk">悬停</span> 自动吸附窗口/控件</span>
              <span className="sep" />
              <span><span className="hk">Tab / 方向键</span> 切换控件</span>
              <span className="sep" />
              <span><span className="hk">Enter</span> 进入标注</span>
              <span className="sep" />
              <span><span className="hk">Esc</span> 退出</span>
            </>
          ) : (
            <>
              <span><span className="hk">滚轮</span> 缩放</span>
              <span className="sep" />
              <span><span className="hk">方向键</span> 微调</span>
              <span className="sep" />
              <span><span className="hk">Enter</span> 复制</span>
              <span className="sep" />
              <span><span className="hk">Esc</span> 返回</span>
            </>
          )}
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
          className={`sel-rect${fixedPreview ? " fixed-preview" : ""}`}
          style={{ left: css(displaySel.x), top: css(displaySel.y), width: css(displaySel.w), height: css(displaySel.h) }}
        >
          {/* 尺寸标签：位置由 layoutSizeLabel 算（跟随选区、贴屏幕底部时翻到上方）。
              旧实现 CSS 写死 bottom:-30px，选区贴底时标签连带里面的操作提示一起被裁掉。 */}
          {phase === "select" && !fixedPreview && (
            <div
              className={`sel-size${sizeLabel.place === "inside" ? " inside" : ""}`}
              style={{ top: sizeLabel.top }}
            >
              <span>{Math.round(displaySel.w)} × {Math.round(displaySel.h)}</span>
              <span className="hint">单击进标注 · 拖选区移动 · 拖边缘缩放</span>
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

      {/* 长截图「预览即默认」：整页淡预览层（窗口可见、不隐藏），单击截整页 / 拖青线选终点 */}
      {longPreview && previewRect && (
        <div
          className="ls-preview"
          style={{ left: css(previewRect.x), top: css(previewRect.y), width: css(previewRect.w), height: css(previewRect.h) }}
          onMouseDown={onPreviewDown}
        >
          <div className="ls-preview-more" />
          {previewEndY != null && (
            <div className="ls-endline" style={{ top: css(previewEndY - previewRect.y) }}>
              <div className="ls-endknob" />
            </div>
          )}
          <div className="ls-preview-lbl">{previewLabel}</div>
          <div className="ls-preview-tip">单击=截整页 · 拖青线=截到此处 · Esc退出</div>
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
          onLongShot={() => void onLongShotPreview()}
          aiOk={aiOk}
          onSave={() => void runExit("保存", saveImageTo)}
          onPin={() => {
            notePowerUsed("pin"); // B 方案：用过即停脉冲/教练卡
            void runExit("贴图", pinImageAt);
          }}
          onAi={onAiButton}
          // 自动打码「预览式」确认条：由工具栏渲染并锚定「自动打码」按钮上方
          maskOn={maskPreview !== null}
          maskActive={maskPreview?.filter((b) => !b.excluded).length ?? 0}
          onApplyMasks={applyMasks}
          onCancelMasks={() => {
            setMaskPreview(null);
            maskPreviewRef.current = null;
          }}
          // 写着"取消"就该是取消这次截图（微信同款）。
          // "退回选区"留给 Esc / 右键 —— 那两个才是"后退一步"的通用心智。
          onCancel={close}
          onDone={() => void copyImage()}
          onMore={() => void finish()}
          discover={discoverTools}
          newHints={newHints}
          coachHint={coachHint}
          onCoachClose={() => {
            if (coachHint) {
              const s = new Set(seenHints);
              s.add(coachHint.id);
              setSeenHints(s);
              writeNewHintSeen(s);
            }
          }}
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
          maskShape={SHAPE_TOOLS.has(tool) ? maskShape : undefined}
          onSelectMaskShape={
            SHAPE_TOOLS.has(tool)
              ? (sp) => setMaskShapes((m) => ({ ...m, [tool]: sp }))
              : undefined
          }
          textSizeId={TEXT_SIZE_TOOLS.has(tool) ? textSizeId : undefined}
          onSelectTextSize={TEXT_SIZE_TOOLS.has(tool) ? setTextSizeId : undefined}
          strengthLevels={
            tool === "mosaic" ? MOSAIC_LEVELS : tool === "blur" ? BLUR_LEVELS : undefined
          }
          strengthValue={
            tool === "mosaic" ? mosaicStrength : tool === "blur" ? blurStrength : undefined
          }
          onSelectStrength={
            tool === "mosaic"
              ? setMosaicStrength
              : tool === "blur"
                ? setBlurStrength
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

/**
 * 给 IPC 调用加超时。长截图循环里每个 invoke 都必须包。
 *
 * 不包的后果很重：裸 `await` 一旦挂起（目标窗口无响应、后端线程卡死），
 * `finally` 永远不会执行 → `show_screenshot_window` 不会被调用 →
 * 截图窗永久隐藏但进程还在，全屏透明覆盖层还挡着鼠标，只能杀进程。
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${what} 超时（${ms}ms）`)),
      ms,
    );
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * canvas → **PNG** dataURL。
 *
 * 用 `toBlob` 而不是 `toDataURL`：后者是**同步**的，一张上万像素高的长图
 * 能把主线程卡住好几秒 —— 期间界面完全无响应，看起来就是“卡死了”。
 *
 * ⚠️ 曾经是 JPEG 0.92，已改回无损。原因：用户反馈“截图没有实际图片清晰”，
 * 查出有损压缩叠了两代：后端底图已经是 JPEG q90（且 image 0.25 的 JpegEncoder
 * 写死 4:2:2 色度抽样，与 quality 无关），这里再编一次就是第二代。
 * 屏幕内容（大片纯色 + 大量硬边 + 细文字）恰好是 JPEG 最不擅长的题材，
 * 表现为文字边缘发虚、带彩色镶边。ShareX 默认 PNG 用的就是这个理由。
 *
 * 为什么这里改得起：本函数只在用户点了「完成 / 更多 / 保存 / 贴图」之后跑，
 * PNG 多花的百毫秒级耗时无感；而底图那条路是按下快捷键后的**即时路径**，
 * 不能照搬（用户已经抱怨过一次“截图速度有点慢”），得等 encode_bench 的数字。
 *
 * 落盘不用改：`save_screenshot_image` 走 `image::guess_format` 自动认格式，
 * 会自己存成 .png。
 */
function canvasToDataUrl(c: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas 编码失败"));
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error ?? new Error("读取编码结果失败"));
      fr.readAsDataURL(blob);
    }, "image/png");
  });
}

/**
 * 合成图落盘：编码 → 保存 → **撤销 OCR 临时登记**。
 *
 * 第三步不能漏。`save_screenshot_image` 是 md5 去重的，而提前 OCR 存的是选区原图；
 * 用户没画标注时结果图与选区原图像素一致 → md5 相同 → 拿到的是**同一个路径**。
 * 不撤销登记的话关窗时 `purge_ocr_temp` 会把它删掉，卡片就指向一个不存在的文件
 * （界面上表现为「图片加载失败」）。
 *
 * 收口在这里而不是在两个调用点各写一遍：finalizeCanvas（长截图/普通完成）与
 * ensureResultPath（完成/更多/保存/贴图）都要落盘，漏一处就是同一个 bug（规则 11.1）。
 */
async function saveResultImage(
  out: HTMLCanvasElement,
): Promise<{ path: string; dataUrl: string }> {
  const dataUrl = await canvasToDataUrl(out);
  const path = await withTimeout(
    invoke<string>("save_screenshot_image", { dataBase64: dataUrl }),
    15000,
    "保存截图",
  );
  // 失败不能影响主流程：撤销登记没成功最坏是多留一个临时文件，
  // 而抛出去会让「完成」整个失败。
  void invoke("unmark_ocr_temp", { path }).catch((e) =>
    logger.warn("撤销 OCR 临时登记失败（图片可能被误清理）", e),
  );
  // 一并把已经编码好的 dataUrl 送出去：谁要是还需要一份图的 URL（贴图浮动预览），
  // 直接用这份，不要再调 canvas.toDataURL()——那个是同步编码，长图能卡住主线程好几秒。
  return { path, dataUrl };
}

/** 把一帧缩成 26×40 的小图给状态窗。每帧一次这个尺寸的 JPEG 编码，成本可忽略。 */
function thumbOf(c: HTMLCanvasElement): string | null {
  try {
    const t = document.createElement("canvas");
    t.width = 26;
    t.height = 40;
    const tx = t.getContext("2d");
    if (!tx) return null;
    tx.drawImage(c, 0, 0, 26, 40);
    return t.toDataURL("image/jpeg", 0.6);
  } catch {
    return null; // 缩略图失败不能影响长截图本身
  }
}

/** 把未知异常转成一句可读文本（Tauri invoke 抛的常常是字符串而不是 Error） */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** 属性条高度（padding 4×2 + 选项 24 + border 2）。它的内容高度固定，不必实测。 */
const ATTR_BAR_H = 34;
/** 会用到属性条的工具（橡皮擦 / 马赛克 / 模糊 不需要颜色与粗细，选中时属性条自动收起） */
const ATTR_TOOLS = new Set<ToolId>([
  "rect",
  "ellipse",
  "arrow",
  "pen",
  "highlight",
  "text",
  "number",
  "picker",
  // 马赛克 / 模糊也要属性条 —— 它们的强度档位要看得见，
  // 不能只靠一个没任何提示的滚轮手势
  "mosaic",
  "blur",
  // 橡皮擦（= 删除）也要属性条：真橡皮擦的半径就是它的粗细档位，
  // 不给调节路径就只能“要么擦不准、要么擦太多”。
  "eraser",
]);
/** 不用颜色的工具（属性条上隐藏整个颜色组） */
const NO_COLOR_TOOLS = new Set<ToolId>(["mosaic", "blur", "eraser"]);
/** 线宽对哪些工具有意义。
 *
 *  橡皮擦（= 删除）也加进来了：真橡皮擦靠半径判定要擦掉哪几个采样点，
 *  半径不可调就只能“要么擦不准、要么擦太多”。 */
const WIDTH_TOOLS = new Set<ToolId>(["rect", "ellipse", "arrow", "pen", "eraser"]);
/** 支持“矩形 / 涂抹”形状切换的遮罩类工具 */
const SHAPE_TOOLS = new Set<ToolId>(["mosaic", "blur", "highlight"]);
/** 用字号而不是线宽的工具 */
const TEXT_SIZE_TOOLS = new Set<ToolId>(["text", "number"]);
/** 橡皮半径：把线宽档位放大。
 *  线宽是 2/3/5，直接当半径用太小——擦一条 3px 的线需要对准到 3px。 */
const ERASER_RADIUS_SCALE = 6;

/* 长截图：滚动后等画面稳定的参数（取代固定 sleep(280)）。
 * 固定 280ms × 40 帧 = 11.2 秒纯等待，快页面也得陪着等；
 * 改成轮询后快页面 60~120ms 就走，慢页面最多等 400ms（比原来还宽松，不会截糊）。 */
const STABLE_STEP_MS = 60;
const STABLE_MAX_MS = 400;
const STABLE_PROBE_W = 240;

/** 单个 IPC 调用的超时。截一块选区正常在百毫秒内，3s 还不回就是真挂住了。 */
const LONG_IPC_TIMEOUT_MS = 3000;
/**
 * 整轮长截图的总时长上限。超时按"停止并出图"处理，已拼的不浪费。
 * MAX_STEPS 从 40 降到 20：40 帧 × 单帧 0.5~1s = 20~40 秒，这段时间窗口是隐藏的，
 * 用户只能干等，很容易当成卡死。20 屏对绝大多数页面已经够长。
 */
const LONG_DEADLINE_MS = 25_000;
/** 接缝羽化的斜坡行数：续接帧顶部保留这么多重叠行，合成时往上叠回去做 0→1 交叉淡化。 */
const LONG_FEATHER = 8;
/**
 * 贴图浮动预览的钳位尺寸（CSS 像素）。
 * 与 screenshot.css 里 `.pin-float-img` 的 max-width/max-height 加上工具条高度对齐。
 * ❌ 初始定位与拖动钳位必须用**同一套**常量：旧实现一边写 140/130、一边写 120，
 * 于是弹出来的位置和拖得到的边界对不上。
 */
const PIN_FLOAT_W = 240;
const PIN_FLOAT_H = 210;
/**
 * 超过这个高度的合成图跳过 OCR。
 * 长截图产物动辄上万像素高，OCR 要跑几十秒到几分钟，而用户要的是图不是文字。
 * 不跳的话这一步会把整个流程拖住 —— 而那正是"点了长截图一直等"的真凶之一。
 */
const LONG_OCR_MAX_H = 4000;

/** OCR 胶囊 / 抽屉的宽度，必须与 screenshot.css 里 `.ocr-drawer` 的 width 一致。 */
const OCR_PANEL_W = 252;

/** 等后端预截屏的上限。实测全屏截屏+编码约 300ms，留一倍余量。
 *  超时就自截 —— 宁可多等一下，也不能因为预截屏卡住就打不开截图。 */
const PENDING_WAIT_MS = 700;
/** 轮询间隔：够密才不浪费预截屏提前跑的那段时间 */
const PENDING_POLL_MS = 25;

