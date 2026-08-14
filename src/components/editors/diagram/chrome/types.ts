/**
 * 画布外围 UI（chrome）的共享契约。
 *
 * 两套布局（RoomyChrome / CompactChrome）拿的是**同一个** ChromeActions，
 * 区别只在怎么摆。把 20 多个回调收成一个对象而不是平铺成 props，
 * 是为了两个壳的签名不会各自漂移——加一个动作只改这一处。
 */
import type { Edge } from "@xyflow/react";
import type { DNode, NodeShape, EdgeLine } from "@/lib/diagram/types";

/** 布局引擎：紧凑(dagre) / 大图(elk) / 自动(按节点数选)。
 *  原先在 DiagramToolbar.tsx 里，那个文件已拆成两套壳，类型搬到这里做单一来源。 */
export type LayoutEngine = "dagre" | "elk" | "auto";

export interface ChromeActions {
  /* 工具栏 */
  addNode: () => void;
  addShape: (s: NodeShape) => void;
  /** 在画布中心新建一个空区域框 */
  addGroup: () => void;
  /** 开始 / 结束拖拽（null = 结束）。仅用于落点预览，不参与建节点 */
  onDragShape: (s: DragKind | null) => void;
  openImport: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  layoutEngine: LayoutEngine;
  setLayoutEngine: (e: LayoutEngine) => void;
  runLayout: () => void;
  layouting: boolean;

  /* 状态栏 */
  nodeCount: number;
  edgeCount: number;
  zoom: number;

  /* 选中对象（两者互斥，由 DiagramCanvas 保证） */
  selectedNode: DNode | null;
  selectedEdge: Edge | null;

  /* 节点属性 */
  aiOn: boolean;
  aiBusy: boolean;
  onLabel: (id: string, label: string) => void;
  onColor: (c: string) => void;
  onStroke: (c?: string) => void;
  onTextColor: (c?: string) => void;
  onShape: (s: NodeShape) => void;
  onFontSize: (v?: number) => void;
  onFocal: (v: boolean) => void;
  onPolish: () => void;
  onExpand: () => void;
  onDeleteNode: () => void;

  /* 连线属性 */
  onEdgeLabel: (id: string, label: string) => void;
  onEdgeLine: (id: string, line: EdgeLine) => void;
  onDeleteEdge: (id: string) => void;
}

/** 布局分档阈值（px，按**画布容器实际宽度**而不是窗口宽度判）。
 *
 * 758 是宽档三块并排的最小需求：
 *   边距12 + 形状库150 + 间距12 + 工具栏340 + 间距12 + 属性面板220 + 边距12
 * 取 760 留 2px 余量。
 *
 * **不能按窗口宽判**：窗口 800px 时弹窗画布是 696（该紧凑）而全屏是 768（该宽档），
 * 同一窗口尺寸下两个壳归属不同档。
 */
export const COMPACT_MAX_WIDTH = 760;

/**
 * 渲染属性浮岛所需的最小画布宽度。
 *
 * **这与 COMPACT_MAX_WIDTH 是两个无关的门槛，当初把它们当成一个开关是错的：**
 * 760 管的是「左竖栏 + 顶栏 + 右面板三块并排」；而浮岛就一排按钮、实测约 338px，
 * 402px 的画布都装得下。按 760 一刀切的结果是：600px 窗口（画布 512）下
 * 浮岛永远不出现。
 *
 * 380 = 浮岛 338 + 两侧留白，再窄就会被钳制成贴边、尖角指不准，那时才只留抽屉。
 */
export const ISLAND_MIN_WIDTH = 380;

/**
 * 形状拖拽的 dataTransfer 类型。
 *
 * 用**自定义 MIME 而不是 `text/plain`**：否则从外部（浏览器 / 编辑器）拖任意文本
 * 进画布也会被当成“新建形状”，凭空多出一个节点。
 *
 * 注：dragover 阶段出于安全限制读不到 getData()，只能看 `types`；
 * 所以“正在拖哪个形状”另用 onDragShape 往上报（落点预览要显形状名）。
 */
export const SHAPE_DRAG_MIME = "application/pastepanda-shape";

/**
 * 区域框在拖放通道里的 key。
 * 它不是一个 NodeShape（不对应任何 Mermaid 形状），所以单独拿出来走；
 * 落点时先比它、再走 asShape，否则会被 asShape 静静归成 rect 变成一个普通节点。
 */
export const GROUP_DRAG_KEY = "group";

/** 形状库能拖出来的东西：十一种形状 + 区域框 */
export type DragKind = NodeShape | typeof GROUP_DRAG_KEY;
