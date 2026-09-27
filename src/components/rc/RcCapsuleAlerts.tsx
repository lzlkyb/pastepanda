/**
 * RcCapsuleAlerts — 浮条身份段的链路警示胶囊组（2026-09-26 从 RcSessionCapsule
 * 原样搬出，为质量读数芯片腾组件行数空间；行为零变化）。
 *
 * 三枚胶囊互斥靠 linkState 本身：failed 红 / unstable·reconnecting 琥珀 /
 * 「操作后 Ns 无画面」琥珀；failed 时「重连」贴着警示一步直达（案 17.2）。
 */
import { linkStateHint, linkStateLabel } from "@/lib/rcSessionStats";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleAlerts({
  link,
  tab,
  busy,
  onReconnect,
}: {
  link: RcLinkSnapshot;
  /** 浮条隐藏期间的 tabIndex 锁。 */
  tab?: number;
  busy: boolean;
  onReconnect?: () => void;
}) {
  return (
    <>
      {/* 审计 Sam 红旗（2026-09-27）：警示胶囊原先 span+title，键盘/读屏用户
          看得到红字却拿不到 title 里的完整 hint。tabIndex 跟随浮条显隐锁
          （tab：显示时 0 / 隐藏时 -1），focus-visible 描边见 CSS。 */}
      {link.state === "failed" && (
        <span className={styles.capPillBad} title={linkStateHint(link.state)} tabIndex={tab ?? 0}>
          {linkStateLabel(link.state)}
        </span>
      )}
      {(link.state === "unstable" || link.state === "reconnecting") && (
        <span className={styles.capPillWarn} title={linkStateHint(link.state)} tabIndex={tab ?? 0}>
          {linkStateLabel(link.state)}
        </span>
      )}
      {link.unansweredSec > 0 && (
        <span
          className={styles.capPillWarn}
          title="操作已发往对方，但画面尚未变化"
          tabIndex={tab ?? 0}
        >
          操作后 {link.unansweredSec}s 无画面
        </span>
      )}
      {link.state === "failed" && onReconnect && (
        <button
          type="button"
          tabIndex={tab}
          className={styles.capBtn}
          disabled={busy}
          title="断开当前连接并重新发起"
          onClick={onReconnect}
        >
          重连
        </button>
      )}
    </>
  );
}
