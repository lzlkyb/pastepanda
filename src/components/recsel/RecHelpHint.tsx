/**
 * RecHelpHint — 条 / 窗右端的 `?`：操作说明默认收起，就地点开（L4 就地解释、V7 删元素测试）。
 *
 * 2026-10-16 从 RecOverlayParts 抽出：录前条与预览窗都要它。两处各写一遍必然走形
 * （图标尺寸、aria-expanded、浮层圆角、点击外面的行为），而它承载的正是被 §5.1
 * 从常驻行里删掉的那些教学——载体只有一个才守得住「同一信息只有一个载体」。
 *
 * 用 `aria-expanded` + `aria-haspopup` 报展开态；`role="note"` 而不是 tooltip：
 * 它由点击展开、可停留、可选中文字，与 hover 才出现的 tooltip 不是一类东西。
 */
import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import styles from "./RecOffice.module.css";

export function HelpHint({
  open,
  onToggle,
  flipBelow = false,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** 承载条贴屏顶时把浮层翻到下方（同 `SettingsCluster` 的 flipBelow；
   *  不开这个开关，盒子会整块伸出屏幕上沿被 `recsel.css` 的 overflow:hidden 裁掉）。 */
  flipBelow?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={styles.helpWrap}>
      <button
        type="button"
        className="rec-icon-btn"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="true"
        title="操作说明"
        aria-label="操作说明"
      >
        <CircleHelp size={13} aria-hidden="true" />
      </button>
      {open && (
        <span
          className={`rec-glass ${styles.helpBox}${flipBelow ? ` ${styles.helpBoxBelow}` : ""}`}
          role="note"
        >
          {children}
        </span>
      )}
    </span>
  );
}
