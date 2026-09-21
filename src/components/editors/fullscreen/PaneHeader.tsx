/**
 * 全屏编辑器的编辑 / 预览面板头（纯展示）
 *
 * 从 `FullscreenEditor.tsx` 抽出。两个面板头结构相近但**不是同一个东西**：
 *   - 编辑侧只有标题；
 *   - 预览侧还有副标签（`spec.previewSubLabel`）与 markdown 专属的行号开关。
 * 所以不强行合成一个「万能 PaneHeader」，只把两者共同的一层（标题行布局）抽出来，
 * 预览侧再叠自己的额外元素 —— 这样以后任一侧单独演化都不会牵动另一侧。
 */
import type { ReactNode } from "react";
import styles from "../FullscreenEditor.module.css";

interface PaneHeaderProps {
  /** 面板标题（编辑 / 预览） */
  label: string;
  /** 副标签，仅预览侧使用 */
  subLabel?: string;
  /** 标题右侧的额外控件（如行号开关） */
  children?: ReactNode;
}

export function PaneHeader({ label, subLabel, children }: PaneHeaderProps) {
  return (
    <div className={styles.paneHeader}>
      <span className={styles.paneLabel}>{label}</span>
      {subLabel && <span className={styles.paneSubLabel}>{subLabel}</span>}
      {children}
    </div>
  );
}

interface PreviewPaneHeaderProps {
  /** 主文案（P0-2 面板身份：markdown「排版预览」，其余「预览」） */
  label?: string;
  subLabel?: string;
  /** markdown 才需要行号开关 */
  showLineNumbersToggle: boolean;
  lineNumbersOn: boolean;
  onToggleLineNumbers: () => void;
}

/** 预览面板头：标题 + 副标签 + （markdown）行号开关 */
export function PreviewPaneHeader({
  label = "预览",
  subLabel,
  showLineNumbersToggle,
  lineNumbersOn,
  onToggleLineNumbers,
}: PreviewPaneHeaderProps) {
  return (
    <PaneHeader label={label} subLabel={subLabel}>
      {showLineNumbersToggle && (
        <button
          type="button"
          className={`${styles.lnToggle} ${lineNumbersOn ? styles.lnToggleActive : ""}`}
          onClick={onToggleLineNumbers}
          title="预览区行号（块级编号 + 代码行号）"
        >
          <span className={styles.lnToggleDot} />
          行号
        </button>
      )}
    </PaneHeader>
  );
}
