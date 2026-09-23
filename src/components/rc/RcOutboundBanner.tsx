/**
 * RcOutboundBanner — 主窗顶栏「我方正在远程/申请远程对方」横幅。
 *
 * B2（2026-09-23）从 `RcOverlay` 拆出：该文件超 300 行红线，纪律要求拆分先行。
 * 行为与原内联块一致，唯一变化是失败分支补了 toast（原先 `if (ok)` 无 else）。
 */
import { useToast } from "@/components/Toast";
import { runRcAction } from "@/lib/rcFeedback";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { confirmDialog } from "@/lib/confirm";
import type { RcSession } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcOutboundBanner({
  session,
  busy,
  onCancel,
  onEnd,
}: {
  session: RcSession;
  busy: boolean;
  onCancel: () => Promise<boolean>;
  onEnd: () => Promise<boolean>;
}) {
  const { toast } = useToast();
  const isPending = session.phase === "outbound_pending";
  const name = rcDisplayName(session, fingerprintOf(session.peer));

  // F-1 / U4：与被控横幅同一道 danger 确认——误触代价不对称；
  // 撤销窗口内的 toast 撤回仍免确认（可撤销优先）。
  const handleClick = () => {
    void (async () => {
      const ok = await confirmDialog({
        title: isPending ? "取消远程申请" : "结束远程会话",
        message: isPending
          ? `将撤回对「${name}」的远程申请。对方若尚未同意，将不再看到这条申请。`
          : `将断开与「${name}」的连接。你这边的画面与控制会立刻结束。`,
        confirmText: isPending ? "取消申请" : "结束会话",
        variant: "danger",
      });
      if (!ok) return;
      await runRcAction(
        isPending ? onCancel : onEnd,
        isPending
          ? { ok: "已取消远程申请", fail: "取消申请失败" }
          : { ok: "已结束远程会话", fail: "结束会话失败" },
        toast,
      );
    })();
  };

  return (
    <div className={styles.ctrlBanner} role="status">
      <span className={styles.who}>
        <span className={styles.live} />
        {isPending ? `正在申请远程「${name}」` : `正在远程「${name}」`}
      </span>
      <span className={styles.pillOn}>
        {session.capability === "control" ? "可控" : "只看"}
      </span>
      <span className={styles.sp} />
      {/* F-10：pending 与工作台 RcPendingWait 同口径——不说超时用户会干等到错误面板 */}
      <span className={styles.meta}>
        {isPending ? "等待对方同意 · 2 分钟内未响应将自动取消" : "打开「远程电脑」可看画面"}
      </span>
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={busy}
        onClick={handleClick}
      >
        {isPending ? "取消申请" : "立即结束"}
      </button>
    </div>
  );
}
