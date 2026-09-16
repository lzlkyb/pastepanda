/**
 * RcErrorPanel — 远程失败分档展示（标题 + 下一步）。
 */
import { explainRcError } from "@/lib/rcDeny";
import styles from "./RemoteComputer.module.css";

export function RcErrorPanel({
  error,
  onRetry,
  onDismiss,
}: {
  error: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const info = explainRcError(error);
  return (
    <div className={styles.noteBad}>
      <div className={styles.errTitle}>{info.title}</div>
      <div className={styles.errHint}>{info.hint}</div>
      {info.reason && info.reason !== info.title && (
        <div className={`${styles.meta} ${styles.errMeta}`}>详情：{info.reason}</div>
      )}
      <div className={styles.errActions}>
        {onRetry && (
          <button type="button" className={styles.miniBtnPri} onClick={onRetry}>
            重试
          </button>
        )}
        {onDismiss && (
          <button type="button" className={styles.miniBtn} onClick={onDismiss}>
            知道了
          </button>
        )}
      </div>
    </div>
  );
}
