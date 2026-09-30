/**
 * RcDeviceRestrictList — 「已配对设备」点开的那张子表（逐台的远程限制）。
 *
 * 它原先住在 `RcAllowPanel` 的「设备级限制」里，和它管的对象（设备列表）隔着两块面板：
 * 改一台的免确认要上下滚着找。搬进组 1「谁能连进来」后，行是「已配对设备」，
 * 点开就是这十一列的列表（设计稿 §3 最后一条归属调整）。
 *
 * 🔴 子表有自己的开合位，**不跟随组的开合**：用户态是「组开 + 子表收」两个独立位，
 * 所以它挂在组组件（不会被卸载的那层）而不是自己这里。收起组时它作为组内行之一
 * 一起不渲染——这两件事不冲突：状态在上、显隐在下。
 *
 * 与「暂停同步」是两个开关：这里只停远程（原文案保留，它是这次搬迁里唯一容易混淆的点）。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import { deviceAvatarStyle, presenceMainLabel, rcDisplayName, relTime } from "@/lib/rcDevice";
import { useToast } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";
import type { RcStatus, RcTargetDevice } from "@/lib/api/rc";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";

export function RcDeviceRestrictList({
  rc,
  status,
  targets,
}: {
  rc: UseRc;
  status: RcStatus;
  targets: RcTargetDevice[];
}) {
  // 逐台的「免确认 / 允许被远程」是**被控**授权，判据跟着后端真值 `status.enabled`
  // （原 `RcAllowPanel` 同一条）。组 1 里只有这张子表吃它，其余行都是出站动作。
  const off = !status.enabled;
  const { toast } = useToast();
  const gray = off ? ` ${styles.rcPanelOff}` : "";
  if (targets.length === 0) {
    return (
      <div className={`${shared.lanPanel}${gray}`}>
        <div className={styles.rcEmpty}>
          还没有配对设备。先在「远程配对设备」那行完成远程配对。
        </div>
      </div>
    );
  }
  return (
    <div className={`${shared.lanPanel}${gray}`}>
      <div className={`${shared.lanDeviceList} ${styles.rcDevListFlush}`}>
        {targets.map((d) => {
          const denied = status.device_deny[d.node_id] ?? d.denied;
          // 方案 D「免确认直连」：逐台开关，默认关。被禁止的设备先解除禁止
          // 才谈得上免确认（deny 优先级更高，按钮直接禁用把这件事说在明处）。
          const trusted = d.trusted ?? false;
          // A4：设备名走统一显示名（备注优先、自报名兜底），与工作台同一口径。
          const displayName = rcDisplayName(d, "未命名设备");
          return (
            <div key={d.node_id} className={shared.lanDeviceItem}>
              <div className={shared.lanDeviceAvatar} style={deviceAvatarStyle(d.node_id)}>
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div className={shared.lanDeviceInfo}>
                <div className={shared.lanDeviceName}>{displayName}</div>
                <div className={shared.lanDeviceTime}>
                  {fingerprintOf(d.node_id)} ·{" "}
                  {presenceMainLabel(
                    (d.presence as "live" | "recent" | "seen" | "never") || "seen",
                    relTime(d.last_seen),
                  )}
                </div>
              </div>
              <span
                className={`${styles.rcDevState} ${denied ? styles.rcDevStateOff : styles.rcDevStateOn}`}
              >
                {denied ? "已禁止" : "允许"}
              </span>
              <button
                type="button"
                className={`${shared.lanRefreshBtn} ${styles.rcDevBtn}`}
                disabled={off || rc.busy || denied}
                title={
                  denied
                    ? "该设备已被禁止远程本机；先点「允许」解除禁止再谈免确认"
                    : trusted
                      ? "这台设备远程本机不再逐次询问。点击恢复每次询问"
                      : "开启后这台设备发起远程时不再逐次询问你（仍是已配对设备，可随时关回）"
                }
                onClick={() => {
                  const next = !trusted;
                  void rc.setDeviceTrust(d.node_id, next).then((ok) => {
                    if (ok && next) {
                      toast(`已对「${displayName}」开启免确认：它发起远程时不再询问你`, "success");
                    }
                  });
                }}
              >
                {trusted ? "免确认·开" : "免确认"}
              </button>
              <button
                type="button"
                className={`${shared.lanRefreshBtn} ${styles.rcDevBtn}`}
                disabled={off || rc.busy}
                onClick={() => void rc.setDeviceAllowed(d.node_id, denied)}
              >
                {denied ? "允许" : "关闭"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
