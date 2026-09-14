/**
 * 列表 / 网格 形态切换器。
 *
 * 🔴 名字不能叫 `NoteViewModeSwitch`：那个已存在，是**编辑器**的
 *   仅编辑/分屏/仅预览。两个名字撞一起会很难看懂。
 *
 * 🔴 红线：无 AI。
 *
 * 2026-09：去掉 gridDisabled——网格任意宽度可点；窄栏由列数自适应（1 列）。
 */
import { List, LayoutGrid } from "lucide-react";
import type { NoteLayout } from "./useNoteLayout";
import styles from "../KnowledgeView.module.css";

export function NoteLayoutSwitch({
  value,
  onChange,
}: {
  value: NoteLayout;
  onChange: (l: NoteLayout) => void;
}) {
  return (
    <div className={styles.modeSeg} role="group" aria-label="列表形态">
      <button
        type="button"
        className={`${styles.modeBtn} ${value === "list" ? styles.modeOn : ""}`}
        onClick={() => onChange("list")}
        title="列表"
        aria-label="列表"
        aria-pressed={value === "list"}
      >
        <List size={14} />
      </button>
      <button
        type="button"
        className={`${styles.modeBtn} ${value === "grid" ? styles.modeOn : ""}`}
        onClick={() => onChange("grid")}
        title="网格"
        aria-label="网格"
        aria-pressed={value === "grid"}
      >
        <LayoutGrid size={14} />
      </button>
    </div>
  );
}
