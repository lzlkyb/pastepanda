/**
 * 空画布引导（从 DiagramCanvas 拆出，规则 #7）。
 */
import { FileCode, Plus } from "lucide-react";
import styles from "../DiagramCanvas.module.css";

export function DiagramEmptyState({ onImport, onAddNode }: { onImport: () => void; onAddNode: () => void }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="7" height="5" rx="1.5" />
          <rect x="14" y="15" width="7" height="5" rx="1.5" />
          <path d="M10 6.5h4a2 2 0 0 1 2 2v6.5" strokeDasharray="2 2" />
        </svg>
      </div>
      <div className={styles.emptyTitle}>画布还是空的</div>
      <div className={styles.emptySub}>双击画布空白处，或从下面任选一种方式开始</div>
      <div className={styles.emptyActions}>
        <div className={`${styles.emptyAction} ${styles.emptyActionPrimary}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 3v4M5 7h4M3 5l6 6" />
          </svg>
          双击空白添加节点
        </div>
        <button className={styles.emptyAction} onClick={onImport}>
          <FileCode size={14} /> 导入 Mermaid 文本
        </button>
        <button className={styles.emptyAction} onClick={onAddNode}>
          <Plus size={14} /> 点「节点」按钮
        </button>
      </div>
      <div className={styles.emptyHint}>
        <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</span>
        <span><kbd>Delete</kbd> 删除</span>
        <span><kbd>Ctrl</kbd>+<kbd>D</kbd> 复制</span>
        <span><kbd>F</kbd> 适配</span>
        <span><kbd>L</kbd> 布局</span>
      </div>
    </div>
  );
}
