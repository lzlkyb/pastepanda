/**
 * RcErrorPanel — 远程失败分档展示（标题 + 下一步）。
 */
import { explainRcError } from "@/lib/rcDeny";
import styles from "./RemoteComputer.module.css";

export function RcErrorPanel({
  error,
  onRetry,
  retryLabel = "重试",
  onDismiss,
}: {
  error: string;
  onRetry?: () => void;
  /** U3：重试按钮写明动作对象（如「重试连接「客厅的电脑」」），别让人猜它重试什么。 */
  retryLabel?: string;
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
            {retryLabel}
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
