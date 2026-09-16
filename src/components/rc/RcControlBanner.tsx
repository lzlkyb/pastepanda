/**
 * RcControlBanner — 被控中常驻横幅：谁 + 能力 + 时长 + 结束（规则 15）。
 *
 * B3：横幅还要负责「对方改了画面范围」的可见提示。观察者（包括只看会话）
 * 能改被观察者的采集范围，原来是静默的——用户不知道自己的画面被切到别处。
 * 提示一直留到用户点「知道了」或会话结束（store 在会话切换/结束时清）。
 */
import { useEffect, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration, scopeLabelLong } from "@/lib/rcSessionStats";
import type { RcSession } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcControlBanner({
  session,
  busy,
  onEnd,
  scopeNotice,
  onDismissScopeNotice,
}: {
  session: RcSession;
  busy: boolean;
  onEnd: () => void;
  /** 对端刚改成的画面范围；null 表示没有待展示的变更 */
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.id]);

  return (
    <div className={styles.ctrlBanner}>
      {/* C5：live region 只包「状态变化」（被控中），不包每秒刷新的计时器 */}
      <div role="status" aria-live="polite">
        <span className={styles.who}>
          <span className={styles.dotDanger} />
          正在被「{session.peer_name || fingerprintOf(session.peer)}」远程
        </span>
        <span className={styles.pillDanger}>
          {session.capability === "control" ? "可控" : "只看"}
        </span>
      </div>
      {/* 计时器：纯视觉、每秒变，移出 live region，避免屏幕阅读器每秒播报 */}
      <span className={styles.timer} aria-hidden="true">
        {formatDuration(now - session.started_ms)}
      </span>
      {/* B3：只在真的发生变更时出现，属于一次性状态变化，放 live region 里播一次是对的 */}
      {scopeNotice && (
        <span className={styles.scopeNotice} role="status" aria-live="polite">
          对方把画面范围改成了「{scopeLabelLong(scopeNotice)}」
          <button
            type="button"
            className={styles.scopeNoticeX}
            onClick={onDismissScopeNotice}
          >
            知道了
          </button>
        </span>
      )}
      <span className={styles.sp} />
      <span className={styles.meta}>
        {session.capability === "control"
          ? "对方可操作键鼠与剪贴板 · 你随时可结束"
          : "对方仅可观看画面 · 你随时可结束"}
      </span>
      <button type="button" className={styles.dangerBtn} disabled={busy} onClick={onEnd}>
        立即结束
      </button>
    </div>
  );
}
