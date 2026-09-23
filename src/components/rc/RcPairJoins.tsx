/**
 * RcPairJoins — 主窗「有设备想完成远程配对」的敲门列表。
 *
 * B2（2026-09-23）从 `RcOverlay` 拆出（300 行红线，拆分先行）；两条动作补失败 toast。
 */
import { useToast } from "@/components/Toast";
import { runRcAction } from "@/lib/rcFeedback";
import { fingerprintOf } from "@/lib/fingerprint";
import { DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice";
import type { RcJoinRequest } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcPairJoins({
  joins,
  busy,
  onDenyJoin,
  onApproveJoin,
}: {
  joins: RcJoinRequest[];
  busy: boolean;
  onDenyJoin: (peer: string) => Promise<boolean>;
  onApproveJoin: (peer: string, name: string) => Promise<boolean>;
}) {
  const { toast } = useToast();
  if (joins.length === 0) return null;
  return (
    <div className={styles.joinGlobal}>
      <h4>🔔 有 {joins.length} 台设备想完成远程配对</h4>
      {joins.map((j) => (
        <div key={j.node_id} className={styles.joinItem}>
          <div className={styles.joinFp}>{fingerprintOf(j.node_id)}</div>
          <div className={`${styles.meta} ${styles.joinHint}`}>
            核对指纹后再允许（与知识库同步配对无关）
          </div>
          <div className={styles.joinBtns}>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                void runRcAction(
                  () => onDenyJoin(j.node_id),
                  { ok: "已拒绝配对", fail: "拒绝配对失败" },
                  toast,
                );
              }}
            >
              拒绝
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                void runRcAction(
                  () => onApproveJoin(j.node_id, DEFAULT_RC_DEVICE_NAME),
                  { ok: "已允许远程配对", fail: "允许配对失败" },
                  toast,
                );
              }}
            >
              允许配对
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
