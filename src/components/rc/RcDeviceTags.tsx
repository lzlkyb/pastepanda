/**
 * RcDeviceTags — 设备行名称区的那一串徽章（从 `RcDeviceRow` 拆出，2026-09-20）。
 *
 * 拆它的直接原因：`RcDeviceRow` 当时**正好 300 行**（`.tsx ≤ 300` 红线），这一批
 * 还要再加一个「自动接收」徽章。照项目规矩「要动它先把要改的那块拆出去」——
 * 不是往上堆，也不是把别人撑破。
 *
 * 这里只负责「这台设备当前是什么状态」的**只读**表达；改状态的入口全在 ⋯ 菜单
 * （见 `RcDeviceMenu`）。两者必须同时更新，否则会出现「徽章说开着、菜单说关着」。
 *
 * 🔴 `denied` 的优先级**高于** `trusted` / `auto_accept`：后端门禁里 deny 先判，
 *    被禁止时另两个开了也不生效，所以那时不摆它们的徽章——`已禁止控本机` 已经
 *    解释了真实状态，再摆一个「免确认」会让人误以为已经放行了。
 */
import type { RcTargetDevice } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export function RcDeviceTags({
  d,
  displayName,
  isLast,
  syncOnly,
  denied,
}: {
  d: RcTargetDevice;
  /** 显示名 = 备注（起过才用）→ 对端自报名 → 占位。调用方算好，避免两处口径。 */
  displayName: string;
  /** 是不是上次用过的设备（`上次` 徽章）。 */
  isLast: boolean;
  /** 纯同步配对设备（只在同步 `devices` 表里，没有远程通道）。 */
  syncOnly: boolean;
  /** 已禁止其控制本机（含 `deviceDeny` 覆盖）。压过下面两个。 */
  denied: boolean;
}) {
  const trusted = d.trusted ?? false;
  const autoAccept = d.auto_accept ?? false;

  return (
    <div className={styles.name}>
      {displayName}
      {d.note?.trim() && (
        <span className={styles.metaSub} title="本机备注 · 对端自报名保留不动">
          {" "}
          ({d.name})
        </span>
      )}
      {isLast && <span className={styles.tagRecent}>上次</span>}
      <span className={syncOnly ? styles.tagSync : styles.tagRc}>
        {syncOnly ? "同步" : "远程"}
      </span>
      {denied && <span className={styles.tagDenied}>已禁止控本机</span>}
      {/* A1：免确认的当前态要用行上的常驻徽章说清——否则「以后不再询问」只活在
          菜单里，用户翻遍界面看不出这台设备已经被放行。 */}
      {trusted && !denied && (
        <span
          className={styles.tagTrusted}
          title="这台设备发起远程时不再弹确认条 · 可随时在菜单里恢复"
        >
          免确认
        </span>
      )}
      {/* 决策 10：同理——「自动接收」开了而界面上看不出来，
          就等于文件会在用户没看屏幕时落进下载目录，那是这个功能最需要被看见的一面。
          徽章文案刻意带「收」字（`自动收文件`）：它只影响**别人发给我**，
          与 `免确认`（对方能控我的屏幕）是两件事，不能让两个字都读成同一件事。 */}
      {autoAccept && !denied && (
        <span
          className={styles.tagAutoAccept}
          title="这台设备发来的文件会自动存到默认接收目录 · 可随时在菜单里关闭"
        >
          自动收文件
        </span>
      )}
    </div>
  );
}
