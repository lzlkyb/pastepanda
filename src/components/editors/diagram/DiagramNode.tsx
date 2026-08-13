/**
 * 节点渲染器 + 「双击改文案」上下文（从 DiagramCanvas 拆出，规则 #7）。
 *
 * 设计红线：节点严禁玻璃拟态 / backdrop-filter（规则 8.3：重复元素叠加 = N 个合成层，
 * 卡顿且糊）。节点用「实底 + 柔和阴影」，玻璃只用在工具栏 / 属性面板等浮层。
 */
import { createContext, useContext, type CSSProperties } from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { CLIPPED_SHAPES, asShape, type DNode } from "@/lib/diagram/types";
import styles from "../DiagramCanvas.module.css";

export interface EditCtxValue {
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  commitLabel: (id: string, label: string) => void;
}

export const EditCtx = createContext<EditCtxValue | null>(null);

function DiagramNode({ id, data, selected }: NodeProps<DNode>) {
  const ctx = useContext(EditCtx);
  const shape = asShape(data.shape);
  const accent = data.color || "var(--accent)";
  const isEditing = ctx?.editingId === id;
  return (
    <div
      className={`${styles.node} ${styles[`shape_${shape}`]} ${selected ? styles.nodeSelected : ""} ${isEditing ? styles.nodeEditing : ""} ${data.focal ? styles.nodeFocal : ""}`}
      data-colored={data.color && !data.focal && !CLIPPED_SHAPES.has(shape) ? "true" : undefined}
      style={{ "--node-accent": accent, ...(data.stroke ? { "--node-stroke": data.stroke } : {}), ...(data.fontSize ? { fontSize: `${data.fontSize}px` } : {}) } as CSSProperties}
      onDoubleClick={(e) => {
        e.stopPropagation();
        ctx?.setEditingId(id);
      }}
    >
      {/* 连接点：四向均作为 source，配合 ReactFlow ConnectionMode.Loose，
          任意节点间均可拖拽连线（手动从零绘制流程图的核心能力）。 */}
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Left} id="left" />
      {isEditing ? (
        <input
          autoFocus
          className={styles.nodeInput}
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

export const nodeTypes: NodeTypes = { diagram: DiagramNode as unknown as React.ComponentType<NodeProps> };
