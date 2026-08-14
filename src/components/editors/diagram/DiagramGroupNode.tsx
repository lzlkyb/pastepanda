/**
 * 区域框（subgraph 分组）的渲染器。
 *
 * 三件事情必须成套，少一件就坏：
 *  1. pointer-events:none 加在**节点外壳** `.react-flow__node-group` 上（CSS）——
 *     只写内层没用，外壳才是命中区域，不关的话整块区域吃走鼠标事件，
 *     框内空白处就无法框选、也拖不动画布。
 *  2. 标题栏带全局类名 diagram-group-head，它就是 React Flow 的 dragHandle——
 *     **不能用 CSS Modules 的哈希类名**，React Flow 拿字符串去 querySelector。
 *  3. 不出 Handle：区域框不参与连线（模型层 parseDiagram 也会把指向它的边过滤掉）。
 */
import { useContext, type CSSProperties } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { DNode } from "@/lib/diagram/types";
import { EditCtx } from "./DiagramNode";
import styles from "../DiagramCanvas.module.css";

export function DiagramGroupNode({ id, data, selected }: NodeProps<DNode>) {
  const ctx = useContext(EditCtx);
  const isEditing = ctx?.editingId === id;
  const tint = data.color || "var(--accent)";
  return (
    <div
      className={`${styles.groupBox} ${selected ? styles.groupBoxSel : ""}`}
      style={{ "--group-tint": tint } as CSSProperties}
    >
      <NodeResizer isVisible={selected} minWidth={140} minHeight={100} />
      <span
        className={`${styles.groupHead} diagram-group-head`}
        title="拖动标题栏移动整组 · 双击改名"
        onDoubleClick={(e) => {
          e.stopPropagation();
          ctx?.setEditingId(id);
        }}
      >
        {isEditing ? (
          <input
            autoFocus
            // 同 DiagramNode 里的节点输入框，但这里更必须：标题栏本身就是 dragHandle，
            // 输入框在它里面——不加 nodrag，拖着选标题文字会拖走整个分组，
            // 连带框内所有节点一起移，看上去就是“整个画布在动”。
            className={`${styles.groupHeadInput} nodrag nopan`}
            defaultValue={data.label}
            onBlur={(e) => ctx?.commitLabel(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") ctx?.setEditingId(null);
            }}
          />
        ) : (
          data.label || "分组"
        )}
      </span>
    </div>
  );
}
