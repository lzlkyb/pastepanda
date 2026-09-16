/**
 * RcJoinRequests — 入站申请确认条。同意远程是**最高危**操作，不设任何全局快捷键
 * （B6）：只保留显式按钮点击，避免主窗口列表里按 Enter 正好撞上远程申请而直接被控。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import type { RcInboundKnock } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcJoinRequests({
  pending,
  busy,
  onApprove,
  onDeny,
}: {
  pending: RcInboundKnock[];
  busy: boolean;
  onApprove: (nodeId: string) => void;
  onDeny: (nodeId: string) => void;
}) {
  if (pending.length === 0) return null;

  return (
    <div className={styles.joinGlobal}>
      <h4>🔔 有 {pending.length} 台设备想远程这台电脑</h4>
      {pending.map((r) => (
        <div key={r.peer} className={styles.joinItem}>
          <div className={`${styles.meta} ${styles.joinMeta}`}>对方指纹</div>
          <div className={styles.joinFp}>{fingerprintOf(r.peer)}</div>
          <p className={styles.joinNote}>
            申请能力：<b>{r.capability === "control" ? "可控（含只看）" : "只看"}</b>
            {r.peer_name ? ` · 设备名「${r.peer_name}」（可自称，以指纹为准）` : ""}
          </p>
          <div className={styles.joinBtns}>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => onDeny(r.peer)}
            >
              拒绝
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => onApprove(r.peer)}
            >
              同意远程
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
