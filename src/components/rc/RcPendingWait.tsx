/**
 * RcPendingWait — 发起申请后的等待区：对象、能力、已等待时长。
 */
import { Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcPendingWait({
  peerName,
  capability,
  waitingMs,
  busy,
  onCancel,
}: {
  peerName: string;
  capability: string;
  waitingMs: number;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <div
      className={styles.noteWarn}
      style={{ flexDirection: "column", alignItems: "stretch" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Loader2 size={14} className={styles.spin} />
        <span>
          已向 <b>{peerName}</b> 发送申请（{capability === "control" ? "可控" : "只看"}
          ），等待对方确认…
        </span>
      </div>
      <div className={styles.meta} style={{ marginTop: 6 }}>
        对方需打开 PastePanda 并同意。对方未开「允许被远程」时会直接拒绝。
        {waitingMs > 0 && <> · 已等待 {formatDuration(waitingMs)}</>}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          type="button"
          className={styles.miniBtn}
          disabled={busy}
          onClick={onCancel}
        >
          取消申请
        </button>
      </div>
    </div>
  );
}
