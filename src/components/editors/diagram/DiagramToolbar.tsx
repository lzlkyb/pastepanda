/**
 * 画布的三块外围 UI：顶部工具栏 / 左侧形状库 / 底部状态栏。
 * 纯展示，所有动作由 DiagramCanvas 传入（从它里拆出，规则 #7）。
 */
import { Undo2, Redo2, Plus, LayoutGrid, FileCode, Loader2 } from "lucide-react";
import type { NodeShape } from "@/lib/diagram/types";
import { SHAPES } from "./shapes";
import styles from "../DiagramCanvas.module.css";

export type LayoutEngine = "dagre" | "elk" | "auto";

export function DiagramToolbar({
  onAddNode, onOpenImport, onUndo, onRedo, canUndo, canRedo,
  layoutEngine, onLayoutEngineChange, onLayout, layouting, nodeCount,
}: {
  onAddNode: () => void;
  onOpenImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  layoutEngine: LayoutEngine;
  onLayoutEngineChange: (e: LayoutEngine) => void;
  onLayout: () => void;
  layouting: boolean;
  nodeCount: number;
}) {
  return (
    <div className={styles.toolbar}>
      <button className={styles.toolBtn} onClick={onAddNode} title="添加节点（或双击画布空白处）">
        <Plus size={15} /> 节点
      </button>
      <button className={styles.toolBtn} onClick={onOpenImport} title="从 Mermaid 文本导入流程图">
        <FileCode size={15} /> 导入
      </button>
      <span className={styles.divider} />
      <button className={styles.toolBtn} onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
        <Undo2 size={15} />
      </button>
      <button className={styles.toolBtn} onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
        <Redo2 size={15} />
      </button>
      <span className={styles.divider} />
      <div className={styles.layoutWrap}>
        <button className={styles.toolBtn} onClick={onLayout} disabled={layouting || nodeCount === 0} title="自动布局">
          {layouting ? <Loader2 size={15} className={styles.spin} /> : <LayoutGrid size={15} />} 布局
        </button>
        <select
          className={styles.engineSelect}
          value={layoutEngine}
          onChange={(e) => onLayoutEngineChange(e.target.value as LayoutEngine)}
          title="布局引擎：紧凑(dagre) / 大图(elk) / 自动(按节点数)"
        >
          <option value="dagre">紧凑</option>
          <option value="elk">大图</option>
          <option value="auto">自动</option>
        </select>
      </div>
    </div>
  );
}

/** 左侧形状库：点击在画布中心添加对应形状节点 */
export function DiagramShapeLibrary({ onAddShape }: { onAddShape: (s: NodeShape) => void }) {
  return (
    <div className={styles.shapeLibrary}>
      <div className={styles.libTitle}>形状</div>
      {SHAPES.map((s, i) => {
        // 奇数个形状时把最后一格横跨两列，不要在右下角留个空洞
        const wide = i === SHAPES.length - 1 && SHAPES.length % 2 === 1;
        return (
          <button
            key={s.key}
            className={`${styles.libShapeBtn} ${wide ? styles.libShapeWide : ""}`}
            title={`${s.label} · ${s.hint}`}
            onClick={() => onAddShape(s.key)}
          >
            <span className={styles.libShapeIco}>{s.icon}</span>
            <span className={styles.libShapeLbl}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 底部状态栏：节点/连线数、布局引擎、当前缩放 */
export function DiagramStatusBar({
  nodeCount, edgeCount, layoutEngine, zoom,
}: {
  nodeCount: number;
  edgeCount: number;
  layoutEngine: LayoutEngine;
  zoom: number;
}) {
  return (
    <div className={styles.statusBar}>
      <span>节点 {nodeCount}</span>
      <span className={styles.statusDivider} />
      <span>连线 {edgeCount}</span>
      <span className={styles.statusDivider} />
      <span>引擎 {layoutEngine === "dagre" ? "紧凑" : layoutEngine === "elk" ? "大图" : "自动"}</span>
      <span className={styles.statusDivider} />
      <span>缩放 {Math.round(zoom * 100)}%</span>
      <span className={styles.statusDivider} />
      <span>类型 diagram · 已派生 Mermaid 副本</span>
    </div>
  );
}
