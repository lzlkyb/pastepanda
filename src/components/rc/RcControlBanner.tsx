/**
 * RcControlBanner — 被控中常驻横幅：谁 + 能力 + 时长 + 结束（规则 15）。
 *
 * B3：横幅还要负责「对方改了画面范围」的可见提示。观察者（包括只看会话）
 * 能改被观察者的采集范围，原来是静默的——用户不知道自己的画面被切到别处。
 * Q10：同理负责「对方改了画质/编码」的提示，一直是静默 log。
 * 提示一直留到用户点「知道了」或会话结束（store 在会话切换/结束时清）。
 */
import { useEffect, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration } from "@/lib/rcSessionStats";
import { scopeLabelLong } from "@/lib/rcScope";
import { qualityLabel } from "@/lib/rcQuality";
import type { RcSession } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcControlBanner({
  session,
  busy,
  trusted,
  onTrust,
  onEnd,
  scopeNotice,
  onDismissScopeNotice,
  streamNotice,
  onDismissStreamNotice,
}: {
  session: RcSession;
  busy: boolean;
  /** 方案 D：该对端是否已开免确认（发起时跳过本机确认条）。 */
  trusted?: boolean;
  /**
   * A2：就地开启免确认——「以后不再询问这台设备」。
   *
   * 时机比入口重要：用户此刻正被这台设备控制着，对「要不要长期放行它」最有判断力。
   * 不传 = 不显示（例如该设备已被禁止远程本机，deny 优先级高于免确认）。
   */
  onTrust?: () => void;
  onEnd: () => void;
  /** 对端刚改成的画面范围；null 表示没有待展示的变更 */
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
  /** Q10：对端刚改的推流档位（quality / codec）；null 表示没有待展示的变更 */
  streamNotice?: { kind: string; name: string } | null;
  onDismissStreamNotice?: () => void;
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
      {/* Q10：画质/编码被对端改动同上——一次性状态变化，播一次 */}
      {streamNotice && (
        <span className={styles.scopeNotice} role="status" aria-live="polite">
          {streamNotice.kind === "codec"
            ? `对方把编码切成了「${streamNotice.name === "h264" ? "H.264" : streamNotice.name === "hevc" ? "HEVC" : "JPEG"}」`
            : `对方把画质调成了「${qualityLabel(streamNotice.name)}」`}
          <button
            type="button"
            className={styles.scopeNoticeX}
            onClick={onDismissStreamNotice}
          >
            知道了
          </button>
        </span>
      )}
      <span className={styles.sp} />
      {/* A2：这里开的是一次性会话里的「长期放行」，文案必须说清边界——
          它是「不再逐次询问」，不是「无人值守」，会话横幅照常常驻、随时可结束。 */}
      {trusted ? (
        <span
          className={styles.trustOn}
          title="这台设备下次发起远程会直接连入；可在设备菜单里恢复逐次询问"
        >
          已免确认
        </span>
      ) : (
        onTrust && (
          <button
            type="button"
            className={styles.miniBtn}
            disabled={busy}
            title="这台设备以后发起远程时直接连入，不再弹这条确认；可随时在设备菜单里关回。仍可随时结束会话。"
            onClick={onTrust}
          >
            以后不再询问
          </button>
        )
      )}
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
