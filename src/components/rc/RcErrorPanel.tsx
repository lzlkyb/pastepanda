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
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{info.title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>{info.hint}</div>
      {info.reason && info.reason !== info.title && (
        <div className={styles.meta} style={{ marginTop: 4 }}>
          详情：{info.reason}
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
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
