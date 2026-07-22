import { memo } from "react";
import type { DiffLine } from "@/hooks/useDiff";
import styles from "./DiffDialog.module.css";

interface DiffPaneProps {
  lines: DiffLine[];
  currentBlock: number;
}

/** 单侧 diff 面板：渲染行号 + 内容 + 高亮 */
export const DiffPane = memo(function DiffPane({ lines, currentBlock }: DiffPaneProps) {
  return (
    <div className={styles.pane}>
      {lines.map((line, i) => {
        const stateClass =
          line.state === "added" ? styles.added :
          line.state === "removed" ? styles.removed :
          line.state === "empty" ? styles.empty : "";
        const isCurrent = line.diffBlock === currentBlock && line.state !== "unchanged" && line.state !== "empty";

        return (
          <div
            key={i}
            className={`${styles.line} ${stateClass}${isCurrent ? ` ${styles.currentDiff}` : ""}`}
          >
            <span className={styles.lineNo}>{line.lineNo ?? ""}</span>
            <span className={styles.lineContent}>
              {line.wordParts
                ? line.wordParts.map((p, j) => (
                    <span
                      key={j}
                      className={p.added ? styles.wordAdd : p.removed ? styles.wordDel : undefined}
                    >
                      {p.text}
                    </span>
                  ))
                : line.text || "\u00A0"}
            </span>
          </div>
        );
      })}
    </div>
  );
});
