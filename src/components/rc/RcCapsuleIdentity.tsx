/**
 * RcCapsuleIdentity — 胶囊的**身份段**（自 RcSessionCapsule 抽出，2026-09-28
 * 方案 A 前置拆薄，`.tsx ≤ 300` 红线）。
 *
 * 这一段是「我在看谁、链路怎样」的读数位：链路灯 → 设备名 → 质量读数芯片 →
 * 能力（可控/只看）→ 键盘态 → 版本偏旧 → 链路警示。全部只读，不带动作
 * （重连按钮在 RcCapsuleAlerts 里，它是警示的一部分）。
 *
 * ⚠️「版本偏旧」不锁显（整场常驻的条件锁了浮条就永远藏不回去）——判据在
 * 父级 useRcCapsuleReveal 的 linkLocked 里，这里只负责摆。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcSession } from "@/lib/api/rc";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import { RcCapsuleAlerts } from "./RcCapsuleAlerts";
import { RcQualityChip } from "./RcQualityChip";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleIdentity({
  session,
  link,
  canControl,
  kbOn,
  peerDgramInput,
  rttMs = 0,
  fps = 0,
  tab,
  busy,
  onReconnect,
}: {
  session: RcSession;
  link: RcLinkSnapshot;
  canControl: boolean;
  /** 键盘捕获态（原底栏灰字「点画面可捕获键盘」上浮到此，最重要的上手提示）。 */
  kbOn: boolean;
  /** `false` = 对方是 7.2.1 及更早的被控端，datagram 鼠标移动收不到。 */
  peerDgramInput?: boolean;
  /** 常驻质量读数（与 detail/RcHud 同一份数据）；无样本整枚不渲染。 */
  rttMs?: number;
  fps?: number;
  /** 隐藏态的 Tab 纪律（-1），由父级按 shown 算好后传下来。 */
  tab?: number;
  busy: boolean;
  onReconnect?: () => void;
}) {
  const dotCls =
    link.state === "connected"
      ? styles.live
      : link.state === "failed"
        ? styles.liveBad
        : styles.liveOff;

  return (
    <>
      <span className={dotCls} />
      <span className={styles.capWho}>
        {rcDisplayName(session, fingerprintOf(session.peer))}
      </span>
      {/* 2026-09-26 对齐稿：常驻质量读数贴着身份段（AnyDesk 顶栏同款位）；
          链路死活仍归 capAlarm/顶条红灯。 */}
      <RcQualityChip rttMs={rttMs} fps={fps} tab={tab} />
      <span className={canControl ? styles.capPillOn : styles.capPillView}>
        {canControl ? "可控" : "只看"}
      </span>
      {canControl &&
        (kbOn ? (
          <span className={styles.capKb}>
            <i aria-hidden="true" />
            键盘已捕获
          </span>
        ) : (
          <span className={styles.capKbOff}>点画面可捕获键盘</span>
        ))}
      {canControl && peerDgramInput === false && (
        <span
          className={styles.capPillWarn}
          title="远程鼠标移动走数据报通道，官方 7.2.1 及更早的被控端收不到。请对方升级 PastePanda 到最新版后重新连接；按键/点击仍可尝试。"
        >
          对方版本偏旧
        </span>
      )}
      <RcCapsuleAlerts link={link} tab={tab} busy={busy} onReconnect={onReconnect} />
    </>
  );
}
