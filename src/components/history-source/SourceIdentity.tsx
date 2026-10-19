import { useSourceIcon } from "@/hooks/useSourceIcon";
import styles from "./HistorySource.module.css";

export function SourceIdentity({ source, sourceIcon }: { source: string; sourceIcon?: string | null }) {
  const { displayName, realIconUrl, emoji } = useSourceIcon(source, sourceIcon);
  return <span className={styles.identity} title={source}>
    <span className={styles.appIcon} aria-hidden="true">{realIconUrl ? <img src={realIconUrl} alt="" /> : emoji}</span>
    <span className={styles.appName}>{displayName}</span>
  </span>;
}
