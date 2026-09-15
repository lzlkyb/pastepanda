/**
 * RcControlBanner — 被控中常驻横幅：谁 + 能力 + 时长 + 结束（规则 15）。
 */
import { useEffect, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration } from "@/lib/rcSessionStats";
import type { RcSession } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcControlBanner({
  session,
  busy,
  onEnd,
}: {
  session: RcSession;
  busy: boolean;
  onEnd: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.id]);

  return (
    <div className={styles.ctrlBanner} role="status">
      <span className={styles.who}>
        <span className={styles.dotDanger} />
        正在被「{session.peer_name || fingerprintOf(session.peer)}」远程
      </span>
      <span className={styles.pillDanger}>
        {session.capability === "control" ? "可控" : "只看"}
      </span>
      <span className={styles.timer}>{formatDuration(now - session.started_ms)}</span>
      <span className={styles.sp} />
      <span className={styles.meta}>对方可操作键鼠与剪贴板 · 你随时可结束</span>
      <button type="button" className={styles.dangerBtn} disabled={busy} onClick={onEnd}>
        立即结束
      </button>
    </div>
  );
}
