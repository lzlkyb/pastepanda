/**
 * 右侧属性面板：选中节点时改颜色/描边/形状/字号/焦点，选中连线时改说明。
 * 纯展示，所有动作由 DiagramCanvas 传入（从它里拆出，规则 #7）。
 */
import { Trash2, Sparkles } from "lucide-react";
import type { Edge } from "@xyflow/react";
import { NODE_COLORS, type DNode, type NodeShape } from "@/lib/diagram/types";
import { SHAPES, STROKE_COLORS } from "./shapes";
import styles from "../DiagramCanvas.module.css";

const FONT_SIZES = [
  { k: "小", v: 12 },
  { k: "中", v: 14 },
  { k: "大", v: 17 },
];

export function NodePropPanel({
  node, aiOn, aiBusy,
  onLabel, onColor, onStroke, onShape, onFontSize, onFocal, onPolish, onExpand, onDelete,
}: {
  node: DNode;
  aiOn: boolean;
  aiBusy: boolean;
  onLabel: (id: string, label: string) => void;
  onColor: (c: string) => void;
  onStroke: (c?: string) => void;
  onShape: (s: NodeShape) => void;
  onFontSize: (v?: number) => void;
  onFocal: (v: boolean) => void;
  onPolish: () => void;
  onExpand: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={styles.propPanel}>
      <div className={styles.propTitle}>节点属性</div>

      {/* 文字：不能只靠双击节点改——连线面板那边本来就有输入框，两边得一致。
          key 里带上 label：外部改了文字（如 AI 润色、双击编辑）时输入框要跟着刷新；
          正在输入时 data.label 未变，不会被重挂打断。 */}
      <div className={styles.propRow}>
        <span>文字</span>
        <input
          key={`${node.id}:${node.data.label}`}
          className={styles.propInput}
          defaultValue={node.data.label}
          placeholder="节点文字"
          onBlur={(e) => onLabel(node.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>

      <div className={styles.propRow}>
        <span>颜色</span>
        <div className={styles.swatches}>
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className={`${styles.swatch} ${(node.data.color || "var(--accent)") === c ? styles.swatchActive : ""}`}
              style={{ background: c }}
              onClick={() => onColor(c)}
            />
          ))}
        </div>
      </div>

      <div className={styles.propRow}>
        <span>描边</span>
        <div className={styles.swatches}>
          <button
            key="stroke-default"
            className={`${styles.swatch} ${!node.data.stroke ? styles.swatchActive : ""}`}
            style={{ background: "var(--diagram-node-border, #e0e4eb)" }}
            title="默认描边"
            onClick={() => onStroke(undefined)}
          />
          {STROKE_COLORS.map((c) => (
            <button
              key={c}
              className={`${styles.swatch} ${(node.data.stroke || "") === c ? styles.swatchActive : ""}`}
              style={{ background: c }}
              onClick={() => onStroke(c)}
            />
          ))}
        </div>
      </div>

      <div className={styles.propRow}>
        <span>形状</span>
        <div className={styles.shapeBtns}>
          {SHAPES.map((s) => (
            <button
              key={s.key}
              className={`${styles.shapeBtn} ${(node.data.shape || "rect") === s.key ? styles.shapeBtnActive : ""}`}
              onClick={() => onShape(s.key)}
              title={s.label}
            >
              {s.icon}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.propRow}>
        <span>字号</span>
        <div className={styles.sizeBtns}>
          {FONT_SIZES.map((o) => (
            <button
              key={o.k}
              className={`${styles.sizeBtn} ${(node.data.fontSize || 13) === o.v ? styles.sizeBtnActive : ""}`}
              onClick={() => onFontSize(o.v)}
              title={`字号 ${o.k}`}
            >
              {o.k}
            </button>
          ))}
          <button
            className={`${styles.sizeBtn} ${!node.data.fontSize ? styles.sizeBtnActive : ""}`}
            onClick={() => onFontSize(undefined)}
            title="默认字号"
          >
            默认
          </button>
        </div>
      </div>

      <div className={styles.propRow}>
        <span>焦点路径</span>
        <div className={styles.seg}>
          <button className={`${styles.segBtn} ${node.data.focal ? styles.segBtnActive : ""}`} onClick={() => onFocal(true)}>
            是
          </button>
          <button className={`${styles.segBtn} ${!node.data.focal ? styles.segBtnActive : ""}`} onClick={() => onFocal(false)}>
            否
          </button>
        </div>
      </div>

      {aiOn && (
        <div className={styles.aiEnhance}>
          <div className={styles.propLabel}>✦ AI 增强</div>
          <button className={styles.aiEnhanceBtn} onClick={onPolish} disabled={aiBusy}>
            <Sparkles size={12} /> {aiBusy ? "处理中…" : "AI 润色文案"}
          </button>
          <button className={styles.aiEnhanceBtn} onClick={onExpand} disabled={aiBusy}>
            <Sparkles size={12} /> {aiBusy ? "处理中…" : "AI 展开子流程"}
          </button>
        </div>
      )}

      <button className={styles.delBtn} onClick={onDelete}>
        <Trash2 size={13} /> 删除节点
      </button>
    </div>
  );
}

export function EdgePropPanel({
  edge, onLabel, onDelete,
}: {
  edge: Edge;
  onLabel: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className={styles.propPanel}>
      <div className={styles.propTitle}>连线属性</div>
      <div className={styles.propRow}>
        <span>说明</span>
        <input
          key={edge.id}
          className={styles.propInput}
          defaultValue={String(edge.label ?? "")}
          placeholder="连线说明（可选）"
          onBlur={(e) => onLabel(edge.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <button className={styles.delBtn} onClick={() => onDelete(edge.id)}>
        <Trash2 size={13} /> 删除连线
      </button>
    </div>
  );
}
