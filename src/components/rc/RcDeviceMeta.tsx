/**
 * RcDeviceMeta — 设备行的第二行：状态点 + 可达性文案 + 提示 + 上次实走路径。
 *
 * 从 RcDeviceRow 拆出（那边拆完仍 303 行，超 .tsx ≤ 300 红线）。这一行本身
 * 由三段拼装而成（状态点 / 主文案 / 「上次 …」），自成一个展示单元。
 *
 * 🔴 「上次走 lan/relay」是**实测值**，不是推断：它来自上一次会话记录的路径，
 * 显示它是因为「上次直连、这次走中继」是用户唯一能察觉质量变化原因的线索。
 * 取不到就不显示（不编默认值）。
 *
 * 指纹曾经也在这行（be0d-5954-…），2026-09-19 按用户要求撤下：日常列表里
 * 这串 ID 没有阅读价值；指纹的真正用途是**配对/接入确认时的人眼比对**，
 * 那些场景（RcPairLayer / RcJoinRequests / RcInboundView 等）原样保留。
 */
import { pathKindLabel } from "@/lib/rcSessionStats";
import type { RcTargetDevice } from "@/lib/api/rc";
import {
  lastSeenHint,
  normalizeRcPresence,
  presenceHint,
  presenceMainLabel,
  relTime,
} from "@/lib/rcDevice";
import styles from "./RemoteComputer.module.css";

export function RcDeviceMeta({ d }: { d: RcTargetDevice }) {
  const presence = normalizeRcPresence(d.presence);
  const lastSeen = relTime(d.last_seen);
  /* v5：状态点升级为头像上的 presence 环 + 角标（见 RcDeviceRow），meta 行只留文字 */
  const mainLabel = presenceMainLabel(presence, lastSeen);
  const hint = presenceHint(presence);
  /** 时间与实走路径合并成一段，不再各占一个「上次」；两者都取不到 ⇒ 整段不渲染。 */
  const tailHint = lastSeenHint(
    lastSeen,
    presence !== "recent" && presence !== "live",
    pathKindLabel(d.last_path ?? ""),
  );
  return (
    <div className={styles.meta}>
      {mainLabel} · {hint}
      {tailHint && (
        <span className={styles.metaSub} title="上次会话实测的信息（路径是实测值，不是推断）">
          {" "}
          · {tailHint}
        </span>
      )}
      {d.source === "sync" && " · 仅同步配对，未建立远程通道"}
    </div>
  );
}
