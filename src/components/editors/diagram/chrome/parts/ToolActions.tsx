/**
 * 工具栏的动作按钮——**两套布局共用这一份**，不拿容器与定位。
 *
 * 文字标签必须包在 <span className={styles.tbLbl}> 里：紧凑档靠 CSS 把标签隐掉、
 * 只留图标（340px → 约 293px），而裸文本节点 CSS 选不中。
 */
import { Undo2, Redo2, Plus, LayoutGrid, FileCode, Loader2 } from "lucide-react";
import type { ChromeActions, LayoutEngine } from "../types";
import styles from "../../../DiagramCanvas.module.css";

export function ToolActions({ a }: { a: ChromeActions }) {
  return (
    <>
      <button className={styles.toolBtn} onClick={a.addNode} title="添加节点（或双击画布空白处）">
        <Plus size={15} />
        <span className={styles.tbLbl}>节点</span>
      </button>
      <button className={styles.toolBtn} onClick={a.openImport} title="从 Mermaid 文本导入流程图">
        <FileCode size={15} />
        <span className={styles.tbLbl}>导入</span>
      </button>
      <span className={styles.divider} />
      <button className={styles.toolBtn} onClick={a.undo} disabled={!a.canUndo} title="撤销 (Ctrl+Z)">
        <Undo2 size={15} />
      </button>
      <button className={styles.toolBtn} onClick={a.redo} disabled={!a.canRedo} title="重做 (Ctrl+Shift+Z)">
        <Redo2 size={15} />
      </button>
      <span className={styles.divider} />
      <div className={styles.layoutWrap}>
        <button
          className={styles.toolBtn}
          onClick={a.runLayout}
          disabled={a.layouting || a.nodeCount === 0}
          title="自动布局"
        >
          {a.layouting ? <Loader2 size={15} className={styles.spin} /> : <LayoutGrid size={15} />}
          <span className={styles.tbLbl}>布局</span>
        </button>
        <select
          className={styles.engineSelect}
          value={a.layoutEngine}
          onChange={(e) => a.setLayoutEngine(e.target.value as LayoutEngine)}
          title="布局引擎：紧凑(dagre) / 大图(elk) / 自动(按节点数)"
        >
          <option value="dagre">紧凑</option>
          <option value="elk">大图</option>
          <option value="auto">自动</option>
        </select>
      </div>
    </>
  );
}
