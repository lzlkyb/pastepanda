/**
 * 节点渲染器 + 「双击改文案」上下文（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 设计红线：节点严禁玻璃拟态 / backdrop-filter（规则 8.3：重复元素叠加 = N 个合成层，
 * 卡顿且糊）。节点用「实底 + 柔和阴影」，玻璃只用在工具栏 / 属性面板等浮层。
 */
import { createContext, useContext, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { CLIPPED_SHAPES, asShape, type DNode } from "@/lib/diagram/types";
import { DiagramGroupNode } from "./DiagramGroupNode";
import styles from "../DiagramCanvas.module.css";

export interface EditCtxValue {
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  commitLabel: (id: string, label: string) => void;
}

export const EditCtx = createContext<EditCtxValue | null>(null);

function DiagramNode({ id, data, selected, width, height }: NodeProps<DNode>) {
  const ctx = useContext(EditCtx);
  const shape = asShape(data.shape);
  const accent = data.color || "var(--accent)";
  const isEditing = ctx?.editingId === id;
  // 手动缩放过的节点：外层 .react-flow__node 已经被 React Flow 设了宽高，
  // 内层 .node 要撑满它并解除 max-width:220 的封顶，否则拖到 300 也只显 220。
  const resized = width != null || height != null;
  return (
    <div
      className={`${styles.node} ${styles[`shape_${shape}`]} ${resized ? styles.nodeResized : ""} ${selected ? styles.nodeSelected : ""} ${isEditing ? styles.nodeEditing : ""} ${data.focal ? styles.nodeFocal : ""}`}
      data-colored={data.color && !data.focal && !CLIPPED_SHAPES.has(shape) ? "true" : undefined}
      style={{ "--node-accent": accent, ...(data.stroke ? { "--node-stroke": data.stroke } : {}), ...(data.textColor ? { "--node-text-color": data.textColor } : {}), ...(data.fontSize ? { fontSize: `${data.fontSize}px` } : {}) } as CSSProperties}
      onDoubleClick={(e) => {
        e.stopPropagation();
        ctx?.setEditingId(id);
      }}
    >
      {/* 缩放手柄：只在选中时出。下限对齐 .node 现有的 min-width:96px；
          不锁定长宽比（菱形 / 六边形这类形状靠拉扭比例才好看）。
          尺寸写回 node.width / node.height 顶层字段，序列化在 types.ts 里接。 */}
      <NodeResizer isVisible={selected} minWidth={96} minHeight={40} />
      {/* 连接点：四向均作为 source，配合 ReactFlow ConnectionMode.Loose，
          任意节点间均可拖拽连线（手动从零绘制流程图的核心能力）。 */}
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Left} id="left" />
      {isEditing ? (
        <input
          autoFocus
          // nodrag / nopan 是 React Flow 的约定类名（默认值，见 noDragClassName / noPanClassName），
          // **不过 CSS Modules**，必须写成字面量。不加的话输入框上的 mousedown 会被 RF 的拖拽接管，
          // 拖着选字变成拖节点（或平移画布），根本选不中文字。
          className={`${styles.nodeInput} nodrag nopan`}
          defaultValue={data.label}
          onBlur={(e) => ctx?.commitLabel(id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") ctx?.setEditingId(null);
          }}
        />
      ) : (
        <span className={styles.nodeLabel}>{data.label || "（双击编辑）"}</span>
      )}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  diagram: DiagramNode as unknown as React.ComponentType<NodeProps>,
  // 与 lib/diagram/types.ts 的 GROUP_TYPE 一致；改名要两头一起改
  group: DiagramGroupNode as unknown as React.ComponentType<NodeProps>,
};
