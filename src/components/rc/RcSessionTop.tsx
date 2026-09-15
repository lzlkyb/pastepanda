/**
 * RcSessionTop — 会话顶栏：谁 / 能力 / 键盘 / 停滞 / 重连 / 结束。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import type { RcSession } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcSessionTop({
  session,
  canControl,
  kbOn,
  stalled,
  busy,
  onReleaseKb,
  onReconnect,
  onRequestEnd,
}: {
  session: RcSession;
  canControl: boolean;
  kbOn: boolean;
  stalled: boolean;
  busy: boolean;
  onReleaseKb: () => void;
  onReconnect?: () => void;
  onRequestEnd: () => void;
}) {
  return (
    <div className={styles.viewTop}>
      <span className={stalled ? styles.liveOff : styles.live} />
      <span>
        正在查看 <b>{session.peer_name || fingerprintOf(session.peer)}</b>
      </span>
      <span className={canControl ? styles.pillOn : styles.pill}>
        {canControl ? "可控" : "只看"}
      </span>
      {canControl && (
        <span className={kbOn ? styles.pillOn : styles.pill}>
          {kbOn ? "键盘已捕获 · Esc 释放" : "键盘：未捕获"}
        </span>
      )}
      {stalled && <span className={styles.pillWarn}>画面已停滞</span>}
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
