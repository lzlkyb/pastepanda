/**
 * RcSessionTop — 会话顶栏：谁 / 能力 / 键盘 / 链路状态 / 未响应 / 重连 / 结束。
 *
 * 🔴 连接灯只由 `linkState` 驱动（对端 pong 的新鲜度），**不再看画面停滞**。
 *    「帧静止」与「链路故障」是两件不相干的事：被控端在画面无变化时本来就
 *    不推帧，拿它当断链证据会让用户看一屏静止桌面 2.5s 就见到红灯
 *    （2026-09-17 改造，判据见 `rcSessionStats.linkStateOf`）。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import type { RcSession } from "@/lib/api/rc";
import { linkStateHint, linkStateLabel, type RcLinkState } from "@/lib/rcSessionStats";
import styles from "./RemoteComputer.module.css";

export function RcSessionTop({
  session,
  canControl,
  kbOn,
  linkState,
  unansweredSec,
  busy,
  onReleaseKb,
  onReconnect,
  onRequestEnd,
}: {
  session: RcSession;
  canControl: boolean;
  kbOn: boolean;
  linkState: RcLinkState;
  /** 操作后未响应秒数；0 = 不提示。 */
  unansweredSec: number;
  busy: boolean;
  onReleaseKb: () => void;
  onReconnect?: () => void;
  onRequestEnd: () => void;
}) {
  // 三色分工：绿=已连接 · 橙=不稳（会自愈，等等就好）· 红=已断开（要动手）
  const dotCls =
    linkState === "connected"
      ? styles.live
      : linkState === "failed"
        ? styles.liveBad
        : styles.liveOff;
  return (
    <div className={styles.viewTop}>
      <span className={dotCls} />
      <span>
        正在查看 <b>{session.peer_name || fingerprintOf(session.peer)}</b>
      </span>
      <span className={canControl ? styles.pillOn : styles.pill}>
        {canControl ? "可控" : "只看"}
      </span>
      {/* 键盘状态不在这里摆了（方案 B）：底栏状态区已有一句「点画面可捕获键盘 /
          键盘已捕获 · Esc 释放」。同一状态在顶栏一个胶囊、底栏一句话，是重复。 */}
      {linkState === "failed" && (
        <span className={styles.pillDanger} title={linkStateHint(linkState)}>
          {linkStateLabel(linkState)}
        </span>
      )}
      {(linkState === "unstable" || linkState === "reconnecting") && (
        <span className={styles.pillWarn} title={linkStateHint(linkState)}>
          {linkStateLabel(linkState)}
        </span>
      )}
      {unansweredSec > 0 && (
        <span className={styles.pillWarn} title="操作已发往对方，但画面尚未变化">
          操作后 {unansweredSec}s 无画面
        </span>
      )}
      <span className={styles.sp} />
      {canControl && kbOn && (
        <button type="button" className={styles.miniBtn} onClick={onReleaseKb}>
          释放键盘
        </button>
      )}
      {onReconnect && (
        <button type="button" className={styles.miniBtn} disabled={busy} onClick={onReconnect}>
          重连
        </button>
      )}
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={busy}
        onClick={onRequestEnd}
      >
        结束会话
      </button>
    </div>
  );
}
