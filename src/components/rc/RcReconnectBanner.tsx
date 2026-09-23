/**
 * RcReconnectBanner — 主窗顶栏「免确认设备异常断流 → 自动重连」横幅（Q6）。
 *
 * B2（2026-09-23）从 `RcOverlay` 拆出（300 行红线，拆分先行）。
 * 变化仅两处：「重新发起」失败补 toast；`gave_up` 常驻文案与原先一致。
 */
import { useToast } from "@/components/Toast";
import { runRcAction } from "@/lib/rcFeedback";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcCapability, RcStatus } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcReconnectBanner({
  reconnecting,
  busy,
  onRetry,
}: {
  reconnecting: NonNullable<RcStatus["reconnecting"]>;
  busy: boolean;
  onRetry: (peer: string, cap: RcCapability) => Promise<boolean>;
}) {
  const { toast } = useToast();
  const name = rcDisplayName(reconnecting, fingerprintOf(reconnecting.peer));
  return (
    <div className={styles.ctrlBanner} role="status" aria-live="polite">
      <span className={styles.who}>
        <span className={styles.live} />
        {reconnecting.gave_up
          ? `「${name}」自动重连失败`
          : `「${name}」连接中断，正在自动重连（${reconnecting.attempt}/${reconnecting.max}）`}
      </span>
      <span className={styles.sp} />
      <span className={styles.meta}>
        {reconnecting.gave_up
          ? "对方可能不在线；也可稍等对方恢复后自动恢复"
          : "对方是免确认设备，重连无需对方确认"}
      </span>
      {reconnecting.gave_up && (
        <button
          type="button"
          className={styles.miniBtn}
          disabled={busy}
          title="立即向这台设备重新发起远程申请"
          onClick={() => {
            void runRcAction(
              () => onRetry(reconnecting.peer, reconnecting.capability as RcCapability),
              { ok: "已重新发起远程申请", fail: "重新发起失败" },
              toast,
            );
          }}
        >
          重新发起
        </button>
      )}
    </div>
  );
}
