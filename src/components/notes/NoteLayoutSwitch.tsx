/**
 * 列表 / 网格 形态切换器。
 *
 * 🔴 名字不能叫 `NoteViewModeSwitch`：那个已存在，是**编辑器**的
 *   仅编辑/分屏/仅预览。两个名字撞一起会很难看懂。
 *
 * 🔴 红线：无 AI。
 */
import { List, LayoutGrid } from "lucide-react";
import type { NoteLayout } from "./useNoteLayout";
import styles from "../KnowledgeView.module.css";

export function NoteLayoutSwitch({
  value,
  onChange,
  gridDisabled,
}: {
  value: NoteLayout;
  onChange: (l: NoteLayout) => void;
  /**
   * 中栏太窄，网格不可用。
   *
   * **置灰而不是隐藏**——直接照搬 `NoteViewModeSwitch` 里 `splitDisabled`
   * 那段现成的论据：拉窗口时按钮数量跳变比一个置灰的按钮更迷惑。
   */
  gridDisabled?: boolean;
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
        onClick={() => {
          if (gridDisabled) return;
          onChange("grid");
        }}
        disabled={gridDisabled}
        /* 置灰时把**为什么**说清楚。只把按钮变淡不告诉原因，
           用户只会以为它坏了。文案句式照 `NoteViewModeSwitch` 那一条。 */
        title={gridDisabled ? "当前宽度放不下网格，把窗口拉宽一些" : "网格"}
        aria-label="网格"
        aria-pressed={value === "grid"}
      >
        <LayoutGrid size={14} />
      </button>
    </div>
  );
}
