/**
 * 传给 <ReactFlow> 的常量配置（从 DiagramCanvas 拆出，规则 #7）。
 * 全是与状态无关的定值，放在一起便于对照。
 */
import { MarkerType } from "@xyflow/react";

/** 节点数超过此阈值才开启视口裁剪（onlyRenderVisibleElements），小图下是无谓开销 */
export const CULL_THRESHOLD = 200;

/** MiniMap 的渲染阈值（节点数）。紧凑档另有一道判断：那一档直接不渲染 */
export const MINIMAP_THRESHOLD = 10;

/** 拖拽吸附网格。取值与 <Background gap={22}> 一致，让节点正好落在背景点阵上；
 *  否则吸附到了但跟背景对不上，反而看着更乱。 */
export const SNAP_GRID = 22;

/**
 * 连线箭头。
 *
 * markerUnits 必须显式给 userSpaceOnUse：React Flow 默认是 strokeWidth，
 * 那样箭头尺寸会跟线宽走——选中时线宽从 1.8 变 2.2、粗线又是 3.4，箭头会一惊一惊。
 *
 * color 在 React Flow 里是写成**内联 style** 而不是 presentation attribute 的，
 * 所以 var() 能解析（写成 fill="var(--x)" 就不行）。
 * 令牌与连线描边同一个，保证箭与线同色。
 */
export const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 18,
  height: 18,
  markerUnits: "userSpaceOnUse",
  color: "var(--diagram-edge-line, #64748b)",
} as const;
