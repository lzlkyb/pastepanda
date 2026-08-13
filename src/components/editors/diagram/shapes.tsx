/**
 * 形状清单与描边色板（DiagramToolbar / DiagramPropPanel 共用）。
 *
 * 图标用内联 SVG 而不是 lucide：平行四边形 / 梯形 / 双框这几种 lucide 没有现成图标，
 * 拿其它图标近似反而让人认不出是哪个形状。手写 path 能把轮廓画准（与设计稿同做法）。
 *
 * hint = 该形状在流程图里的语义，摆在 tooltip 里（格子里只放得下主标签）。
 * key 的取值与 Mermaid 形状一一对应，见 lib/diagram/types.ts 的 NodeShape。
 */
import type { NodeShape } from "@/lib/diagram/types";

const SVG = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinejoin: "round" as const,
} as const;

export interface ShapeSpec {
  key: NodeShape;
  icon: React.ReactNode;
  label: string;
  hint: string;
}

export const SHAPES: ShapeSpec[] = [
  {
    key: "rect",
    label: "矩形",
    hint: "步骤 / 动作",
    icon: (
      <svg {...SVG}>
        <rect x="3" y="7" width="18" height="10" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "round",
    label: "圆角",
    hint: "子流程 / 过程",
    icon: (
      <svg {...SVG}>
        <rect x="3" y="7" width="18" height="10" rx="4" />
      </svg>
    ),
  },
  {
    key: "pill",
    label: "起止",
    hint: "开始 / 结束",
    icon: (
      <svg {...SVG}>
        <rect x="3" y="7" width="18" height="10" rx="5" />
      </svg>
    ),
  },
  {
    key: "ellipse",
    label: "圆形",
    hint: "连接点 / 状态",
    icon: (
      <svg {...SVG}>
        <circle cx="12" cy="12" r="7" />
      </svg>
    ),
  },
  {
    key: "diamond",
    label: "菱形",
    hint: "决策 / 判断",
    icon: (
      <svg {...SVG}>
        <path d="M12 4l8 8-8 8-8-8z" />
      </svg>
    ),
  },
  {
    key: "hexagon",
    label: "六边形",
    hint: "准备 / 循环边界",
    icon: (
      <svg {...SVG}>
        <path d="M8 5h8l4 7-4 7H8l-4-7z" />
      </svg>
    ),
  },
  {
    key: "parallelogram",
    label: "平行四边",
    hint: "输入 / 输出",
    icon: (
      <svg {...SVG}>
        <path d="M7 6h14l-4 12H3z" />
      </svg>
    ),
  },
  {
    key: "trapezoid",
    label: "梯形",
    hint: "手动操作",
    icon: (
      <svg {...SVG}>
        <path d="M8 6h8l4 12H4z" />
      </svg>
    ),
  },
  {
    key: "cylinder",
    label: "圆柱",
    hint: "数据库 / 存储",
    icon: (
      <svg {...SVG}>
        <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3v10c0 1.7-3.6 3-8 3s-8-1.3-8-3z" />
        <path d="M4 7c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
  },
  {
    key: "subroutine",
    label: "双框",
    hint: "子程序 / 预定义过程",
    icon: (
      <svg {...SVG}>
        <rect x="3" y="7" width="18" height="10" rx="1" />
        <path d="M7 7v10M17 7v10" />
      </svg>
    ),
  },
  {
    key: "text",
    label: "文本",
    hint: "注释 / 说明",
    icon: (
      <svg {...SVG}>
        <path d="M5 8h14M5 12h14M5 16h9" strokeDasharray="3 2" />
      </svg>
    ),
  },
];

/** 描边色板（与填充色板区分；首项「默认」= 跟随主题边框） */
export const STROKE_COLORS = ["#0284C7", "#8B5CF6", "#06B6D4", "#64748B", "#EF4444"];
