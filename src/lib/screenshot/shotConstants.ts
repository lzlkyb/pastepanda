/**
 * 截图标注的模块级常量。
 *
 * 从 ScreenshotOverlay 抽出来是为了给那个文件腾行数（claude.md §7），这些值与 React
 * 无关、也不随渲染变化。**纯搬运，数值与注释一字未改** —— 每条注释里的理由都是
 * 真实踩过的坑，改数值前先读注释。
 */

import type { ToolId } from "./types";

/** 属性条高度（padding 4×2 + 选项 24 + border 2）。它的内容高度固定，不必实测。 */
export const ATTR_BAR_H = 34;

/** 会用到属性条的工具（橡皮擦 / 马赛克 / 模糊 不需要颜色与粗细，选中时属性条自动收起） */
export const ATTR_TOOLS = new Set<ToolId>([
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
  "dewarp",
  // 动作型：自动去水印（OCR 重复文字→inpaint），收进去水印属性栏「模式」分段
  "autodewarp",
]);

/** 不用颜色的工具（属性条上隐藏整个颜色组） */
export const NO_COLOR_TOOLS = new Set<ToolId>(["mosaic", "blur", "eraser", "dewarp"]);

/** 线宽对哪些工具有意义。
 *
 *  橡皮擦（= 删除）也加进来了：真橡皮擦靠半径判定要擦掉哪几个采样点，
 *  半径不可调就只能“要么擦不准、要么擦太多”。 */
export const WIDTH_TOOLS = new Set<ToolId>(["rect", "ellipse", "arrow", "pen", "eraser"]);

/** 支持“矩形 / 涂抹”形状切换的遮罩类工具 */
export const SHAPE_TOOLS = new Set<ToolId>(["mosaic", "blur", "highlight", "dewarp"]);

/** 用字号而不是线宽的工具 */
export const TEXT_SIZE_TOOLS = new Set<ToolId>(["text", "number"]);

/** 橡皮半径：把线宽档位放大。
 *  线宽是 2/3/5，直接当半径用太小——擦一条 3px 的线需要对准到 3px。 */
export const ERASER_RADIUS_SCALE = 6;

/* 长截图：滚动后等画面稳定的参数（取代固定 sleep(280)）。
 * 固定 280ms × 40 帧 = 11.2 秒纯等待，快页面也得陪着等；
 * 改成轮询后快页面 60~120ms 就走，慢页面最多等 400ms（比原来还宽松，不会截糊）。 */
export const STABLE_STEP_MS = 60;
export const STABLE_MAX_MS = 400;
export const STABLE_PROBE_W = 240;

/** 单个 IPC 调用的超时。截一块选区正常在百毫秒内，3s 还不回就是真挂住了。 */
export const LONG_IPC_TIMEOUT_MS = 3000;

/**
 * 整轮长截图的总时长上限。超时按"停止并出图"处理，已拼的不浪费。
 * MAX_STEPS 从 40 降到 20：40 帧 × 单帧 0.5~1s = 20~40 秒，这段时间窗口是隐藏的，
 * 用户只能干等，很容易当成卡死。20 屏对绝大多数页面已经够长。
 */
export const LONG_DEADLINE_MS = 25_000;

/** 接缝羽化的斜坡行数：续接帧顶部保留这么多重叠行，合成时往上叠回去做 0→1 交叉淡化。 */
export const LONG_FEATHER = 8;

/**
 * 贴图浮动预览的钳位尺寸（CSS 像素）。
 * 与 screenshot.css 里 `.pin-float-img` 的 max-width/max-height 加上工具条高度对齐。
 * ❌ 初始定位与拖动钳位必须用**同一套**常量：旧实现一边写 140/130、一边写 120，
 * 于是弹出来的位置和拖得到的边界对不上。
 */
export const PIN_FLOAT_W = 240;
export const PIN_FLOAT_H = 210;

/**
 * 超过这个高度的合成图跳过 OCR。
 * 长截图产物动辄上万像素高，OCR 要跑几十秒到几分钟，而用户要的是图不是文字。
 * 不跳的话这一步会把整个流程拖住 —— 而那正是"点了长截图一直等"的真凶之一。
 */
export const LONG_OCR_MAX_H = 4000;

/** OCR 胶囊 / 抽屉的宽度，必须与 screenshot.css 里 `.ocr-drawer` 的 width 一致。 */
export const OCR_PANEL_W = 252;

/** 等后端预截屏的上限。实测全屏截屏+编码约 300ms，留一倍余量。
 *  超时就自截 —— 宁可多等一下，也不能因为预截屏卡住就打不开截图。 */
export const PENDING_WAIT_MS = 700;

/** 轮询间隔：够密才不浪费预截屏提前跑的那段时间 */
export const PENDING_POLL_MS = 25;
