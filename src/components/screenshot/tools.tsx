/**
 * 标注工具表、调色板、线宽档位（纯 UI 常量）。
 *
 * 图标重绘约束（V6.20）：
 * ① 统一 stroke-width 1.5 —— 旧图标混用 1.4 / 1.5 / 1.6，并排时粗细不一，这是"不好看"的直接原因；
 * ② 统一 round 端点与拐角，小尺寸下不会出现尖刺毛边；
 * ③ 不再用 <text> 画字 —— 序号图标原来内嵌 <text>，字体由系统决定，不同 DPI 下位置对不齐；
 * ④ 抽象概念换成行业通用符号（模糊 = 水滴，同 Photoshop；高亮 = 荧光笔）。
 *
 * 但图标再好也解决不了"看不懂"：马赛克 / 模糊 / 高亮 这类概念本来就没有公认图形，
 * 所以每个按钮都带**常驻中文标签**（QQ 截图同款），不再靠悬停 tooltip。
 * 快捷键改到 tooltip 里说，不占按钮位置。
 */

import type { ToolId } from "@/lib/screenshot/types";

/** 所有图标共用的描边参数（统一粗细与端点） */
const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const TOOLS: {
  id: ToolId;
  label: string;
  key?: string;
  icon: React.ReactNode;
  /** 自定义悬停提示；不给就用 `label（按 key）`。
   *  行为比名字复杂的工具才需要它（目前只有橡皮擦）。 */
  tip?: string;
}[] = [
  {
    id: "rect",
    label: "矩形",
    key: "1",
    icon: (
      <svg viewBox="0 0 16 16">
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" {...S} />
      </svg>
    ),
  },
  {
    id: "ellipse",
    label: "椭圆",
    key: "2",
    icon: (
      <svg viewBox="0 0 16 16">
        <ellipse cx="8" cy="8" rx="5.75" ry="4.25" {...S} />
      </svg>
    ),
  },
  {
    id: "arrow",
    label: "箭头",
    key: "3",
    // 箭头头改成实心三角：旧实现是两条细线拼的"⌐"，在 16px 下看着像直角而不像箭头
    icon: (
      <svg viewBox="0 0 16 16">
        <path d="M3.2 12.8L11 5" {...S} />
        <path d="M12.9 3.1L12.4 7.9L8.1 3.6Z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "pen",
    label: "画笔",
    key: "4",
    icon: (
      <svg viewBox="0 0 16 16">
        <path
          d="M2.8 13.2l3.3-.8 6.7-6.7a1.3 1.3 0 0 0 0-1.9l-.6-.6a1.3 1.3 0 0 0-1.9 0L3.6 9.9l-.8 3.3z"
          {...S}
        />
        <path d="M9.9 4.1l2 2" {...S} />
      </svg>
    ),
  },
  {
    id: "highlight",
    label: "高亮",
    key: "5",
    // 荧光笔斜笔头 + 下方色带；旧实现是一个实心矩形，和"矩形"工具几乎看不出区别
    icon: (
      <svg viewBox="0 0 16 16">
        <path d="M5.2 10.4l4.9-4.9 2.4 2.4-4.9 4.9H5.2v-2.4z" {...S} />
        <path d="M9.4 4.2l1.4-1.4 2.4 2.4-1.4 1.4" {...S} />
        <rect x="2.8" y="13.4" width="10.4" height="1.6" rx="0.8" fill="currentColor" opacity="0.8" />
      </svg>
    ),
  },
  {
    id: "mosaic",
    label: "马赛克",
    key: "6",
    icon: (
      <svg viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" {...S} />
        <path
          d="M2.5 2.5h3.7v3.7H2.5zM9.8 2.5h3.7v3.7H9.8zM6.2 6.2h3.6v3.6H6.2zM2.5 9.8h3.7v3.7H2.5zM9.8 9.8h3.7v3.7H9.8z"
          fill="currentColor"
          stroke="none"
          opacity="0.75"
        />
      </svg>
    ),
  },
  {
    id: "blur",
    label: "模糊",
    key: "7",
    // 水滴 = 模糊/柔化的行业通用符号（Photoshop 同款）；
    // 旧实现是三个半透明圆点，与"模糊"没有任何认知关联
    icon: (
      <svg viewBox="0 0 16 16">
        <path d="M8 2.2C8 2.2 3.8 7 3.8 9.6a4.2 4.2 0 0 0 8.4 0C12.2 7 8 2.2 8 2.2z" {...S} />
        <path d="M6 9.8a2 2 0 0 0 2 2" {...S} opacity="0.6" />
      </svg>
    ),
  },
  {
    id: "automask",
    // 无数字快捷键（主栏已占满 1-9 / 0）；提示里只说标签。
    label: "自动打码",
    // 图标 = 一个区域框 + 中间一条实心红条（遮蔽/涂掉），直观表达“自动把隐私涂掉”。
    icon: (
      <svg viewBox="0 0 16 16">
        <rect x="2.6" y="3.2" width="10.8" height="9.6" rx="1.4" {...S} />
        <rect
          x="4.4"
          y="6.6"
          width="7.2"
          height="2.6"
          rx="0.6"
          fill="currentColor"
          stroke="none"
          opacity="0.85"
        />
      </svg>
    ),
    // tip 手写：它是动作型按钮，行为不同于其他绘制工具，必须说清“一键 / 可撤销 / OCR 驱动”。
    tip: "自动打码·一键遮蔽图中手机/身份证/邮箱/银行卡等隐私文字（可撤销，支持 OCR 后）",
  },
  {
    id: "text",
    label: "文字",
    key: "8",
    // 加上底部衬线，否则两笔的 T 在 16px 下像个十字
    icon: (
      <svg viewBox="0 0 16 16">
        <path d="M3 3.8h10" {...S} />
        <path d="M8 3.8v8.4" {...S} />
        <path d="M5.8 12.2h4.4" {...S} />
      </svg>
    ),
  },
  {
    id: "number",
    label: "序号",
    key: "9",
    // 数字 1 用 path 手画，不依赖系统字体（旧实现内嵌 <text>，不同 DPI 下对不齐）
    icon: (
      <svg viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="5.6" {...S} />
        <path d="M6.9 6.6L8.4 5.6v5" {...S} />
        <path d="M6.9 10.6h3" {...S} />
      </svg>
    ),
  },
  {
    id: "eraser",
    // 名字改过两次，记下原因以免反复：
    //   ① 最早叫“橡皮擦”，但当时行为是划到就把**整个标注**删掉
    //      （eraseHits → filter），名不符实 → 一度改成“删除”；
    //   ② 后来实现了真橡皮擦（eraseStrokes 会把笔迹**切成多段**），
    //      名字就该改回来了。
    label: "橡皮擦",
    key: "0",
    // tip 手写而不用默认的 label：它的行为是**混合**的，不说清用户会觉得不一致。
    tip: "橡皮擦·画笔/涂抹会被擦断，矩形文字等整个删除",
    icon: (
      <svg viewBox="0 0 16 16">
        <path
          d="M9.1 2.9l4 4a1 1 0 0 1 0 1.4l-3.6 3.6H5.7L2.9 9.1a1 1 0 0 1 0-1.4l4.8-4.8a1 1 0 0 1 1.4 0z"
          {...S}
        />
        <path d="M6.1 6.1l3.8 3.8" {...S} />
        <path d="M2.5 13.5h11" {...S} />
      </svg>
    ),
  },
];

/** key → 工具 id 查表（快捷键用）。按 key 查、不按数组下标 ——
 *  重排工具时下标跟着动，按键却被用户记住，不能跟着错位
 *  （旧实现 TOOLS[Number(e.key)-1] 一重排就静默按错工具）。 */
export const TOOL_BY_KEY: Partial<Record<string, ToolId>> = Object.fromEntries(
  TOOLS.filter((t) => t.key).map((t) => [t.key as string, t.id]),
);
/** 吸管取色。不在主栏，而是放在属性条的颜色组里 —— 它的作用就是选颜色。 */
export const PICKER_ICON = (
  <svg viewBox="0 0 16 16">
    <path d="M10.4 2.6a1.5 1.5 0 0 1 2.1 0l0.9 0.9a1.5 1.5 0 0 1 0 2.1L6.6 12.4l-3 0.9 0.9-3z" {...S} />
    <path d="M9.4 3.6l3 3" {...S} />
  </svg>
);

/**
 * 取文字（OCR）按钮图标：带折角的文档 + 两条文字线。
 *
 * 为什么不用字母类符号：标注区已经有一个「文字」工具（T 字形），两者并排
 * 若都用字母，用户分不清哪个是“打字”哪个是“识别”。文档轮廓表达的是
 * “从这张图里拿到一份文本”，与标注无关，认知上直接分家。
 */
export const OCR_ICON = (
  <svg viewBox="0 0 16 16">
    <path d="M3.4 2.4h6.1l3.1 3.1v8.1a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z" {...S} />
    <path d="M9.3 2.5v3.2h3.2" {...S} />
    <path d="M5 8.4h6" {...S} />
    <path d="M5 11h4" {...S} />
  </svg>
);

/**
 * 保存到图库：下箭头落入托盘（与系统“下载/另存”的通用符号一致）。
 * 不用软盘：年轻用户认不出那是什么。
 */
export const SAVE_ICON = (
  <svg viewBox="0 0 16 16">
    <path d="M8 2.4v6.7" {...S} />
    <path d="M5.3 6.5L8 9.2l2.7-2.7" {...S} />
    <path d="M2.6 10.6v1.9a1.1 1.1 0 0 0 1.1 1.1h8.6a1.1 1.1 0 0 0 1.1-1.1v-1.9" {...S} />
  </svg>
);

/** 贴图置顶：图钉。emoji 📌 在不同系统字体下粗细/颜色不一，所以手画描边版。 */
export const PIN_ICON = (
  <svg viewBox="0 0 16 16">
    <path d="M6.1 2.6h3.8" {...S} />
    <path d="M8 9.4v4.1" {...S} />
    <path d="M6.6 2.6v3.1L4.9 7.5a.6.6 0 0 0 .43 1.02h5.34a.6.6 0 0 0 .43-1.02L9.4 5.7V2.6z" {...S} />
  </svg>
);

/**
 * ⚠️ 这里没有 AI 图标，是有意的。
 *
 * 全站 AI 标识的唯一外观实现是 `components/ai/AiMark.tsx`，图标固定用
 * lucide 的 `Sparkles`。在这里再手画一个星火就是第七处分叉
 * （AiMark 的注释里记着它曾经散在六处并已经分叉过一次）。
 * 所以 AnnotToolbar 直接 import Sparkles + AiMark，不经过本文件。
 */

/** 标注调色板（红 / 蓝 / 黄 / 绿 / 近黑） */
export const COLORS = ["#ef4444", "#3b9eff", "#facc15", "#22c55e", "#1f2937"];

/**
 * 线宽三档（物理像素）。
 * 旧实现用写死的 LINE_WIDTH = 3，用户改不了 —— 截小图标时 3px 太粗、
 * 截 4K 大图时 3px 又细到看不见。中档保持 3，与历史行为一致。
 */
export const WIDTHS: { id: "thin" | "mid" | "bold"; label: string; w: number; dot: number }[] = [
  { id: "thin", label: "细", w: 2, dot: 4 },
  { id: "mid", label: "中", w: 3, dot: 7 },
  { id: "bold", label: "粗", w: 5, dot: 10 },
];

/**
 * 马赛克色块 / 模糊半径的三档预设（物理像素）。
 *
 * 为什么要有可见档位：旧实现只能滚轮调，而"滚轮可以调强度"这件事
 * 界面上没有任何提示 —— 只有真去滞了才会闪一下 hint，基本不可发现。
 * 现在档位直接放在属性条上，滚轮仍可在档位之间微调。
 *
 * 默认值从 12 降到 8：12px 的色块在 2.5K 屏上看着很粗（实测反馈）。
 */
export const MOSAIC_LEVELS: { id: "fine" | "mid" | "coarse"; label: string; v: number }[] = [
  { id: "fine", label: "细", v: 5 },
  { id: "mid", label: "中", v: 8 },
  { id: "coarse", label: "粗", v: 14 },
];
export const BLUR_LEVELS: { id: "fine" | "mid" | "coarse"; label: string; v: number }[] = [
  { id: "fine", label: "细", v: 4 },
  { id: "mid", label: "中", v: 8 },
  { id: "coarse", label: "粗", v: 16 },
];

/**
 * 文字 / 序号的字号三档，单位是 **CSS 像素**。
 *
 * ❗ 注意单位：与 WIDTHS / MOSAIC_LEVELS（那些是物理像素）**不同**。
 *
 * 字号是感知量，写死物理像素会让 DPI 越高字越小——旧实现的 18 物理像素
 * 在 dpr=1 时是 18px，dpr=2.5 时只有 7.2 CSS 像素，用户反馈的
 * “文字工具看不到任何东西”就是这个（输入框和提交后的图上都小）。
 * 组件会把这里的 css 值 × dpr 再存进 annotation.size（draw.ts 仍然按物理像素画）。
 *
 * 而马赛克/模糊强度不能跟 dpr 缩放：它们的语义是“遮掉多少实际像素”，
 * 物理像素才是对的。
 */
export const TEXT_SIZES: { id: "sm" | "md" | "lg"; label: string; css: number }[] = [
  { id: "sm", label: "小", css: 14 },
  { id: "md", label: "中", css: 20 },
  { id: "lg", label: "大", css: 28 },
];

/** 字号档位步进（供文字迷你工具条 A-/A+）：到头即停，不回环。 */
export function stepTextSize(id: "sm" | "md" | "lg", dir: 1 | -1): "sm" | "md" | "lg" {
  const i = TEXT_SIZES.findIndex((t) => t.id === id);
  const j = Math.max(0, Math.min(TEXT_SIZES.length - 1, i + dir));
  return TEXT_SIZES[j].id;
}

/** 遮罩类工具（马赛克 / 模糊 / 高亮）的形状切换图标 */
export const SHAPE_BRUSH_ICON = (
  <svg viewBox="0 0 16 16">
    <path
      d="M2.6 11.6c2.2-4.4 4.2-6.2 6-5.4 1.8.8.6 3.4 2 4 1.4.6 2.4-.8 2.8-2"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
    />
  </svg>
);
export const SHAPE_RECT_ICON = (
  <svg viewBox="0 0 16 16">
    <rect x="2.6" y="4" width="10.8" height="8" rx="1" {...S} />
  </svg>
);
