/**
 * LanPairedList —— 「记住的设备」列表 + 暂停开关 + 删除入口。
 *
 * 从 `LanSyncPanel` 拆出来只为了那边别超 300 行（规则 #7）；
 * 它不持名单状态，数据与刷新都由父级传进来。
 */
import { useState } from "react";
import { logger } from "@/lib/logger";
import shared from "../Settings.module.css";
import styles from "./Lan.module.css";

/**
 * 记住的设备。
 *
 * 🔴 这份名单是**持久化**的（后端 `lan_paired_devices`）。旧版本拿的是
 * 「最近解密成功过」的内存表：重启就归零，而且对方掉线后仍被当成已配对
 * 而从「附近的设备」里滤掉——于是「既看不见也配不回来」。
 */
export interface PairedDevice {
  device_id: string;
  device_name: string;
  /** 首次记住的时刻（epoch 秒）。 */
  paired_at: number;
  /**
   * 在线。由**招呼包**（每 5 秒一次的心跳）判定。
   *
   * 🔴 不能拿 `last_sync` 当在线判据：加密消息只在剪贴板变动时才发，
   * 那样会同时错两头——安静但在线的显示成离线，已关机的却一直亮着。
   */
  online: boolean;
  /** 本次运行内最近一次同步的时刻；空串 = 本次运行还没同步过。 */
  last_sync: string;
  /** 用户暂停：本机不收不发（不吊销群组密钥）。 */
  paused: boolean;
}

export function LanPairedList({
  devices,
  onChanged,
  toast,
}: {
  devices: PairedDevice[];
  /** 删除成功后让父级重拉名单。 */
  onChanged: () => Promise<void> | void;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  /** 正在删除的设备 id（空 = 没在忙）。 */
  const [deleting, setDeleting] = useState("");
  /** 正在切换暂停的设备 id。 */
  const [pausing, setPausing] = useState("");

  /**
   * 删除一台设备（从本机名单移除，要重新配对）。
   *
   * ❗ 确认文案里必须写明它**不吊销密钥**——局域网同步是单一群组密钥模型，
   *   对方手里还有同一把密钥。不说的话用户会以为点完就断开了。
   */
  const handleDelete = async (d: PairedDevice) => {
    const { confirmDialog } = await import("@/lib/confirm");
    const ok = await confirmDialog({
      title: `删除「${d.device_name}」？`,
      message:
        "它会从本机名单里移除，并重新出现在「附近的设备」里（可以重新配对）。\n\n" +
        "⚠ 这不会吊销配对密钥：对方手里还有同一把密钥，仍然能解开本机的广播。\n" +
        "要真正断开，得在「高级」里重新生成密钥——那会把所有设备一起踢掉。\n\n" +
        "若只想暂时不同步，用旁边的「启用」开关即可。",
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    setDeleting(d.device_id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("lan_forget_device", { deviceId: d.device_id });
      toast(`已删除「${d.device_name}」`, "success");
      await onChanged();
    } catch (e) {
      logger.warn("删除设备失败", e);
      toast(`删除失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setDeleting("");
    }
  };

  /** 暂停 / 恢复。可逆、无确认；失败回滚（父级重拉）。 */
  const handleTogglePause = async (d: PairedDevice) => {
    const next = !d.paused;
    setPausing(d.device_id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("lan_set_device_paused", { deviceId: d.device_id, paused: next });
      toast(
        next
          ? `已暂停「${d.device_name}」——本机不再与它收发剪贴板`
          : `已恢复「${d.device_name}」的同步`,
        "success",
      );
      await onChanged();
    } catch (e) {
      logger.warn("切换设备暂停失败", e);
      toast(
        `${next ? "暂停" : "恢复"}失败：${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
      await onChanged();
    } finally {
      setPausing("");
    }
  };

  if (devices.length === 0) return null;

  return (
    <>
      <div className={styles.lanSectionLabel}>记住的设备</div>
      <div className={shared.lanDeviceList}>
        {devices.map((d, idx) => (
          <div
            key={d.device_id ? `device-${d.device_id}-${idx}` : `device-${idx}`}
            className={`${shared.lanDeviceItem}${d.paused ? ` ${styles.lanDevicePaused}` : ""}`}
          >
            <div
              className={`${shared.lanDeviceAvatar}`}
              style={{
                // 审查：空 device_id 时 charCodeAt 是 NaN → 兜底 0（无效色）
                background: `hsl(${((d.device_id.charCodeAt(0) || 0) * 40) % 360}, 60%, 55%)`,
                opacity: d.paused ? 0.55 : 1,
              }}
            >
              {d.device_name.charAt(0).toUpperCase()}
            </div>
            <div className={`${shared.lanDeviceInfo}`}>
              <div className={`${shared.lanDeviceName}`}>{d.device_name}</div>
              {/* ❗ 这一行把「在线」与「最后同步」分开写。旧版本只有一个时间
                  配上恒亮的绿点，对方已经关机了也看不出来。 */}
              <div className={`${shared.lanDeviceTime}`}>
                {d.paused
                  ? "已暂停 · 停止与本机收发剪贴板"
                  : d.online
                    ? "在线"
                    : "离线"}
                {!d.paused &&
                  (d.last_sync ? ` · 最后同步 ${d.last_sync}` : " · 本次运行还没同步过")}
              </div>
            </div>
            {!d.paused && d.online && (
              <span className={`${styles.lanDeviceOnline}`} title="刚刚还听到它的心跳">
                <span className={styles.dotOnline} />
              </span>
            )}
            {d.paused && (
              <span className={styles.lanDevicePausedBadge} title="本机不再与它收发；对方仍能解密广播">
                已暂停
              </span>
            )}
            <div className={styles.lanPauseSw}>
              <span className={styles.lanPauseLabel}>启用</span>
              <button
                type="button"
                role="switch"
                aria-checked={!d.paused}
                aria-label={d.paused ? "启用与该设备的同步" : "暂停与该设备的同步"}
                className={`${styles.lanPauseToggle}${d.paused ? "" : ` ${shared.on}`}`}
                disabled={pausing === d.device_id}
                onClick={() => void handleTogglePause(d)}
                title={
                  d.paused
                    ? "恢复同步（配对与记录都还在）"
                    : "暂停同步（可随时恢复，无需重新配对）"
                }
              >
                <span className={styles.lanPauseKnob} />
              </button>
            </div>
            <button
              className={shared.lanRefreshBtn}
              onClick={() => void handleDelete(d)}
              disabled={deleting === d.device_id}
              title="从本机名单删除（不会吊销配对密钥）"
            >
              {deleting === d.device_id ? "…" : "删除"}
            </button>
          </div>
        ))}
      </div>
      {/* 🔴 必须说清楚：局域网同步是**单一群组密钥**模型，谁拿到密钥谁就能解密。
          不说的话用户会以为点了「删除」就把对方断开了。 */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 8px" }}>
        「启用」关掉 = 暂停：本机不再与它收发，配对还在，再打开即恢复。
        <br />
        「删除」会清掉本机记录，它会重新出现在上面的「附近的设备」里、可以重新配对。
        <b>两者都不会吊销配对密钥</b>——对方手里还有同一把密钥，仍能解开本机的广播。
        要真正断开，得到下面「高级」里重新生成密钥（那会把<b>所有</b>设备一起踢掉）。
      </div>
    </>
  );
}
