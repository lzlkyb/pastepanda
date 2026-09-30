/**
 * RcReconnectBanner — 主窗顶栏「免确认设备异常断流 → 自动重连」横幅（Q6）。
 *
 * B2（2026-09-23）从 `RcOverlay` 拆出（300 行红线，拆分先行）。
 *
 * 🔴 乙-⑤（2026-09-29，待拍板⑤）：**只讲结果，不报过程**。原先的「（1/3）」计数
 * 拿掉——对标 §6.6 六家都把自动重连当默认体验而非用户决策点，给用户看第几圈只会
 * 让人去数它失败几次。真要用尽就说清下一步（重新发起，可能需要对方同意）。
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
        {reconnecting.gave_up ? `「${name}」没能自动恢复` : `「${name}」连接中断，正在尝试恢复`}
      </span>
      <span className={styles.sp} />
      <span className={styles.meta}>
        {reconnecting.gave_up
          ? "对方可能不在线，或已关闭这台设备的免确认——重新发起时需要对方同意"
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
