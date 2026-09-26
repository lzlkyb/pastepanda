import styles from "../rc/RemoteComputer.module.css";

/**
 * RcCredTag — 凭证徽章（方案 C 2026-09-26）：一色一点一名，让人不用读说明
 * 也知道手里拿的是哪种码；`note` 是跟在徽章后的那句副注。**纯装饰**——
 * 不进任何判定分支，不做点击目标。
 *
 * 三档语义色：`pair` 长期配对（accent）/ `help` 一次性帮助（success）/
 * `uno` 无人值守（warning）。样式在 `RemoteComputer.module.css` 的 `.credRow/.credTag`。
 */
export function RcCredTag({
  tone,
  label,
  note,
}: {
  tone: "pair" | "help" | "uno";
  label: string;
  note?: string;
}) {
  return (
    <div className={styles.credRow}>
      <span className={styles.credTag} data-tone={tone}>
        <i aria-hidden="true" />
        {label}
      </span>
      {note && <span className={styles.foot}>{note}</span>}
    </div>
  );
}
