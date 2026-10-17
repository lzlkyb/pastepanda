/**
 * RcCapsuleAlerts — 浮条身份段的链路警示胶囊组（2026-09-26 从 RcSessionCapsule
 * 原样搬出，为质量读数芯片腾组件行数空间；行为零变化）。
 *
 * 三枚链路胶囊互斥靠 linkState 本身：failed 红 / unstable·reconnecting 琥珀 /
 * 「操作后 Ns 无画面」琥珀（丙-③ 起：对方主动暂停出帧时这一枚不摆，见下方注释）。
 * 其后两枚是**对方机器上的事实**：乙-③「主机取回键鼠」、丙-③「对方已暂停画面」。
 *
 * 甲-④（2026-09-29 一级项重排，对标 §6.4）：「立即重连」从「⋯」二级提到一级，
 * 用 `.capReq`（与「申请控制权」同族主按钮，胶囊宽度最坏 +96px），**只在中断态
 * （unstable / reconnecting / failed）出现**，正常态不占宽。⋯ 面板里那条保留——
 * 它还是「链路正常但想换个连接」的入口。
 */
import { RotateCw } from "lucide-react";
import { linkStateHint, linkStateLabel } from "@/lib/rcSessionStats";
import { rcReconnectPrimaryOf } from "@/lib/rcLinkMask";
import { rcHostHoldPillOf } from "@/lib/rcInputGate";
import { rcPeerPausedPillOf } from "@/lib/rcVideoPause";
import { rcPeerPipePillOf } from "@/lib/rcVideoPipe";
import type { RcPeerInputState } from "@/lib/api/rc";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleAlerts({
  link,
  peerInput,
  peerVideoPaused,
  peerVideoPipe,
  tab,
  busy,
  onReconnect,
}: {
  link: RcLinkSnapshot;
  /** 乙-③：对端报来的主机输入权状态（缺失 = 旧对端，两枚胶囊都不摆）。 */
  peerInput?: RcPeerInputState | null;
  /** 丙-③：对端暂停了向本机推送画面（缺失/否 = 不摆，旧对端没这条帧）。 */
  peerVideoPaused?: boolean;
  /**
   * 丙（2026-10-12，Issue #19）：对端报来的编码档位（`sw` / `enc_fuse` /
   * `grab_fuse` 才摆；缺失或空串 = 旧对端没这条帧 ⇒ 什么都不说）。
   */
  peerVideoPipe?: string;
  /** 浮条隐藏期间的 tabIndex 锁。 */
  tab?: number;
  busy: boolean;
  onReconnect?: () => void;
}) {
  const holdPill = rcHostHoldPillOf(peerInput);
  const pausedPill = rcPeerPausedPillOf(peerVideoPaused);
  const pipePill = rcPeerPipePillOf(peerVideoPipe);
  // 「操作后 Ns 无画面」只被**已经掉成幻灯片**的那两档压掉（软编还跑得动，不压）：
  // 判据与色档同源，见 `rcVideoPipe.ts` 的档位表。
  const pipeBad = pipePill?.tone === "bad";
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
      {/* 丙-③：对方主动暂停出帧时**不摆**「操作后 Ns 无画面」——那帧不来的原因是
          对方按了暂停，不是链路不稳。两条同摆会互相打脸（一条说「等等看」，
          一条说「他在挡着」），而琥珀那条还会把人引向「去重连」。
          🔴 丙（2026-10-12，Issue #19）同理：对方编码已熔断/抓屏熔断时也不摆——
          那时候画面真的在「操作后半天不变」，但原因在他那台机器的编码器，
          摆一条链路警示等于把设备故障说成用户的网络不行，还会把人引去点「重连」。 */}
      {link.unansweredSec > 0 && !pausedPill && !pipeBad && (
        <span
          className={styles.capPillWarn}
          title="操作已发往对方，但画面尚未变化"
          tabIndex={tab ?? 0}
        >
          操作后 {link.unansweredSec}s 无画面
        </span>
      )}
      {/* 🔴 乙-③：这两枚都是**对方机器上的事实**（对端推帧带回来的），措辞不许
          越界：「主机取回键鼠」不写「已断开」（画面与剪贴板都还在动），锁定失败
          只在胶囊上给短标签，完整原因挂在常驻出口条上（胶囊宽度是硬约束）。 */}
      {holdPill && (
        <span
          className={styles.capPillWarn}
          title="对方把自己的键鼠收回去了：你发过去的键鼠会被拦下，画面与剪贴板不受影响。他十分钟不操作会自动归还。"
          tabIndex={tab ?? 0}
        >
          {holdPill}
        </span>
      )}
      {/* 丙-③：对方挡的是**眼睛**不是手——画面停帧，键鼠与剪贴板照常。琥珀与
          「主机取回键鼠」同族（都是「对方此刻收回了一样东西」）。 */}
      {pausedPill && (
        <span
          className={styles.capPillWarn}
          title="对方暂停了向本机推送画面：你看到的是他暂停前那一帧。会话没断，键鼠与剪贴板照常，他恢复后画面继续。"
          tabIndex={tab ?? 0}
        >
          {pausedPill}
        </span>
      )}
      {/* 🔴 丙（2026-10-12，Issue #19）：对方那台机器的编码档位——画面成幻灯片的
          原因常在他机器上（硬编熔断 / 只剩软编 / 抓屏熔断），而症状看起来像「网不好」。
          这条胶囊的全部价值就是替网络澄清，所以措辞必须指到「对方」而不是「链路」。
          旧对端不发这条帧 ⇒ 恒 null ⇒ 不摆（没有证据不摆断言）。 */}
      {pipePill && (
        <span
          className={pipePill.tone === "bad" ? styles.capPillBad : styles.capPillWarn}
          title={pipePill.detail}
          tabIndex={tab ?? 0}
        >
          {pipePill.label}
        </span>
      )}
      {peerInput?.err && (
        <span
          className={styles.capPillBad}
          title={peerInput.err}
          tabIndex={tab ?? 0}
        >
          锁定未生效
        </span>
      )}
      {onReconnect && rcReconnectPrimaryOf(link.state) && (
        <button
          type="button"
          tabIndex={tab}
          className={styles.capReq}
          disabled={busy}
          title="断开当前连接并重新发起"
          onClick={onReconnect}
        >
          <RotateCw size={12} aria-hidden="true" />
          立即重连
        </button>
      )}
    </>
  );
}
