/**
 * RcAskCard — 选设备后的能力选择与发送申请卡。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcAskCard({
  peerId,
  targets,
  cap,
  busy,
  onCap,
  onCancel,
  onSend,
}: {
  peerId: string;
  targets: RcTargetDevice[];
  cap: RcCapability;
  busy: boolean;
  onCap: (c: RcCapability) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const name = targets.find((t) => t.node_id === peerId)?.name || fingerprintOf(peerId);
  return (
    <div className={styles.joinCard}>
      <h4>申请远程「{name}」</h4>
      <p>对方会看到确认条，同意后才开始传输画面。</p>
      <div className={styles.capPills}>
        {(
          [
            ["view", "只看"],
            ["control", "可控（需对方同意）"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={cap === k ? styles.pillOn : styles.pill}
            onClick={() => onCap(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.joinBtns}>
        <button type="button" className={styles.miniBtn} onClick={onCancel}>
          取消
        </button>
        <button type="button" className={styles.miniBtnPri} disabled={busy} onClick={onSend}>
          发送申请
        </button>
      </div>
    </div>
  );
}
