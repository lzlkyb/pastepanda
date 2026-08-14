/**
 * 属性字段的叶子控件——**两套布局共用这一份**。
 *
 * 这里的组件一律不拿定位（不写 position / 不包容器），只负责控件本身。
 * 壳（RoomyChrome / CompactChrome）只拥有定位，而定位恰好就是唯一应该不同的东西。
 * 形状表 / 调色盘都从单一数据源 import，所以「形状从 6 种扩到 11 种」这类改动
 * 不存在只改一边的可能。
 */
import { Trash2, Sparkles } from "lucide-react";
import type { Edge } from "@xyflow/react";
import { NODE_COLORS, edgeLineOf, type DNode, type NodeShape, type EdgeLine } from "@/lib/diagram/types";
import { SHAPES, STROKE_COLORS, TEXT_COLORS } from "../../shapes";
import styles from "../../../DiagramCanvas.module.css";

const FONT_SIZES = [
  { k: "小", v: 12 },
  { k: "中", v: 14 },
  { k: "大", v: 17 },
];

/** 节点文字。key 里带上 label：外部改了文字（AI 润色 / 双击编辑）时输入框要跟着刷；
 *  正在输入时 data.label 未变，不会被重挂打断。 */
export function LabelField({ node, onLabel }: { node: DNode; onLabel: (id: string, v: string) => void }) {
  return (
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
  );
}

export function ColorSwatches({ node, onColor }: { node: DNode; onColor: (c: string) => void }) {
  const active = node.data.color || "var(--accent)";
  return (
    <div className={styles.swatches}>
      {NODE_COLORS.map((c) => (
        <button
          key={c}
          className={`${styles.swatch} ${active === c ? styles.swatchActive : ""}`}
          style={{ background: c }}
          title={`节点颜色 ${c}`}
          onClick={() => onColor(c)}
        />
      ))}
    </div>
  );
}

export function StrokeSwatches({ node, onStroke }: { node: DNode; onStroke: (c?: string) => void }) {
  return (
    <div className={styles.swatches}>
      <button
        className={`${styles.swatch} ${!node.data.stroke ? styles.swatchActive : ""}`}
        style={{ background: "var(--diagram-node-border, #e0e4eb)" }}
        title="默认描边（跟形状语义色）"
        onClick={() => onStroke(undefined)}
      />
      {STROKE_COLORS.map((c) => (
        <button
          key={c}
          className={`${styles.swatch} ${(node.data.stroke || "") === c ? styles.swatchActive : ""}`}
          style={{ background: c }}
          title={`描边 ${c}`}
          onClick={() => onStroke(c)}
        />
      ))}
    </div>
  );
}

/** 文字色。首格是「默认」而不是某个具体颜色——点它 = 删掉 textColor 字段、回落主题色，
 *  与 StrokeSwatches 的做法一致（默认值不入库，否则会凭空亮「未保存」红点）。 */
export function TextColorSwatches({
  node, onTextColor,
}: {
  node: DNode;
  onTextColor: (c?: string) => void;
}) {
  return (
    <div className={styles.swatches}>
      <button
        className={`${styles.swatch} ${styles.swatchAuto} ${!node.data.textColor ? styles.swatchActive : ""}`}
        title="默认 · 跟随主题文字色"
        onClick={() => onTextColor(undefined)}
      />
      {TEXT_COLORS.map((c) => (
        <button
          key={c}
          className={`${styles.swatch} ${(node.data.textColor || "") === c ? styles.swatchActive : ""}`}
          style={{ background: c }}
          title={`文字色 ${c}`}
          onClick={() => onTextColor(c)}
        />
      ))}
    </div>
  );
}

/** 形状网格。cols 由壳决定：宽档的竖向面板用 4 列，紧凑档的贴底抽屉横着摆用 6 列。
 *  原先是 flex 单行无 wrap，11×26px + 10×4px = 326px 塞进 160px，
 *  flex-shrink 把每个按钮压到约 11px、图标全糊。 */
export function ShapeGrid({
  node, onShape, cols,
}: {
  node: DNode;
  onShape: (s: NodeShape) => void;
  cols: 4 | 6;
}) {
  return (
    <div className={`${styles.shapeGrid} ${cols === 6 ? styles.shapeGrid6 : ""}`}>
      {SHAPES.map((s) => (
        <button
          key={s.key}
          className={`${styles.shapeBtn} ${(node.data.shape || "rect") === s.key ? styles.shapeBtnActive : ""}`}
          title={`${s.label} · ${s.hint}`}
          onClick={() => onShape(s.key)}
        >
          {s.icon}
        </button>
      ))}
    </div>
  );
}

export function FontSizeBtns({ node, onFontSize }: { node: DNode; onFontSize: (v?: number) => void }) {
  const cur = node.data.fontSize;
  return (
    <div className={styles.sizeBtns}>
      {FONT_SIZES.map((o) => (
        <button
          key={o.k}
          className={`${styles.sizeBtn} ${cur === o.v ? styles.sizeBtnActive : ""}`}
          title={`字号 ${o.k}`}
          onClick={() => onFontSize(o.v)}
        >
          {o.k}
        </button>
      ))}
      <button
        className={`${styles.sizeBtn} ${!cur ? styles.sizeBtnActive : ""}`}
        title="默认字号"
        onClick={() => onFontSize(undefined)}
      >
        默认
      </button>
    </div>
  );
}

export function FocalToggle({ node, onFocal }: { node: DNode; onFocal: (v: boolean) => void }) {
  return (
    <div className={styles.seg}>
      <button className={`${styles.segBtn} ${node.data.focal ? styles.segBtnActive : ""}`} onClick={() => onFocal(true)}>
        是
      </button>
      <button className={`${styles.segBtn} ${!node.data.focal ? styles.segBtnActive : ""}`} onClick={() => onFocal(false)}>
        否
      </button>
    </div>
  );
}

/** AI 增强。调用方已判过 aiOn（红线 #16：AI 未配置时入口完全不渲染）。 */
export function AiEnhance({ busy, onPolish, onExpand }: { busy: boolean; onPolish: () => void; onExpand: () => void }) {
  return (
    <div className={styles.aiEnhance}>
      <div className={styles.propLabel}>✦ AI 增强</div>
      <button className={styles.aiEnhanceBtn} onClick={onPolish} disabled={busy}>
        <Sparkles size={12} /> {busy ? "处理中…" : "AI 润色文案"}
      </button>
      <button className={styles.aiEnhanceBtn} onClick={onExpand} disabled={busy}>
        <Sparkles size={12} /> {busy ? "处理中…" : "AI 展开子流程"}
      </button>
    </div>
  );
}

/** 删除按钮。iconOnly 给紧凑档的抽屉标题行用（那里只容得下一个图标）。 */
export function DeleteBtn({
  onDelete, label, iconOnly,
}: {
  onDelete: () => void;
  label: string;
  iconOnly?: boolean;
}) {
  return (
    <button
      className={`${styles.delBtn} ${iconOnly ? styles.delBtnIcon : ""}`}
      title={label}
      onClick={onDelete}
    >
      <Trash2 size={13} />
      {!iconOnly && label}
    </button>
  );
}

/** 连线线型。三档直接对应 Mermaid 的 `-->` / `-.->` / `==>`，
 *  所以选什么就能原样导出、导回来还是什么。 */
const EDGE_LINES: { k: EdgeLine; label: string; hint: string }[] = [
  { k: "solid", label: "实线", hint: "普通流向（Mermaid -->）" },
  { k: "dashed", label: "虚线", hint: "弱关联 / 异步（Mermaid -.->）" },
  { k: "thick", label: "粗线", hint: "主干路径（Mermaid ==>）" },
];

export function EdgeLineBtns({ edge, onLine }: { edge: Edge; onLine: (id: string, v: EdgeLine) => void }) {
  const cur = edgeLineOf(edge);
  return (
    <div className={styles.sizeBtns}>
      {EDGE_LINES.map((o) => (
        <button
          key={o.k}
          className={`${styles.sizeBtn} ${cur === o.k ? styles.sizeBtnActive : ""}`}
          title={o.hint}
          onClick={() => onLine(edge.id, o.k)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EdgeLabelField({ edge, onLabel }: { edge: Edge; onLabel: (id: string, v: string) => void }) {
  return (
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
  );
}
