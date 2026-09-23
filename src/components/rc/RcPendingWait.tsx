/**
 * RcPendingWait — 发起申请后的等待区：对象、能力、已等待时长、剩余确认时间。
 *
 * C3：已等待时长从会话 started_ms 起算（而非组件 mount 时间），中途关掉对话框再
 * 打开重新挂载时计数不归零。计算抽成纯函数 waitedMs（src/lib/rcWait.ts）并单测。
 *
 * B（设计稿 §3）：等待态提供「改为可控」——对方还没同意时改档零成本，
 * 实现口径是**作废重发**（取消本次申请 + 以「可控」重新发起），对端只看到一次新敲门。
 * 一旦对方已同意、会话已建立，改档就走会话内的「申请控制权」（RcSessionView），
 * 两条路径不共用同一个入口，避免「这个按钮点了到底改哪一次」的歧义。
 *
 * 批3（2026-09-21）：进度条 + 实时倒计时。稿画的是游走的**不确定**进度条，这里改成
 * **确定**进度条——后端有确切的确认窗口（WAIT_CONFIRM_MS，对齐 service.rs 的
 * 120_000），确定条能多给一条信息「还剩多久」。倒计时只显示不驱动取消，见 rcWait.ts。
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatWaitSpan, waitedMs, waitProgress, waitRemainingMs } from "@/lib/rcWait";
import styles from "./RemoteComputer.module.css";

export function RcPendingWait({
  peerName,
  capability,
  startedMs,
  busy,
  onCancel,
  onRaise,
}: {
  peerName: string;
  capability: string;
  /** 会话/申请开始时间戳（ms）；来自后端状态，重挂不归零 */
  startedMs: number | null | undefined;
  busy: boolean;
  onCancel: () => void;
  /** 以「可控」作废重发本次申请；capability 已是 control 时不渲染按钮。 */
  onRaise?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const waitingMs = waitedMs(startedMs, now);
  const remainingMs = waitRemainingMs(startedMs, now);
  const progress = waitProgress(startedMs, now);
  const pct = progress === null ? 0 : Math.round(progress * 100);

  return (
    <div className={`${styles.noteWarn} ${styles.waitBox}`}>
      <div className={styles.waitHead}>
        <Loader2 size={14} className={styles.spin} />
        <span>
          已向 <b>{peerName}</b> 发送申请（{capability === "control" ? "可控" : "只看"}
          ），等待对方确认…
        </span>
      </div>
      {progress !== null && (
        <div
          className={styles.waitTrack}
          role="progressbar"
          aria-label="等待对方确认"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          {/* 视觉最小 2%：刚发出申请时进度条要看得见（aria-valuenow 仍是真实值） */}
          <span className={styles.waitFill} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      )}
      <div className={`${styles.meta} ${styles.waitMeta}`}>
        {/* U8：一句话说清「对面会发生什么」，别写成说明书 */}
        对方电脑上会弹确认，同意后开始。对方未开「允许被远程」时会直接拒绝。
        · 已等待 {formatWaitSpan(waitingMs)}
        {remainingMs === null
          ? " · 2 分钟内未响应将自动取消"
          : remainingMs > 0
            ? ` · ${formatWaitSpan(remainingMs)}后自动取消`
            : " · 等待超时，正在收尾…"}
      </div>
      <div className={styles.waitActions}>
        {capability !== "control" && onRaise && (
          <button
            type="button"
            className={styles.miniBtnPri}
            disabled={busy}
            title="作废本次申请，改为以「可控」重新发起（对方会收到新的确认）"
            onClick={onRaise}
          >
            改为可控
          </button>
        )}
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
