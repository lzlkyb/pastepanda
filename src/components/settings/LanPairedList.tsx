/**
 * LanPairedList —— 「记住的设备」列表 + 忘记入口。
 *
 * 从 `LanSyncPanel` 拆出来只为了那边别超 300 行（规则 #7）；
 * 它不持名单状态，数据与刷新都由父级传进来。
 */
import { useState } from "react";
import { logger } from "@/lib/logger";
import styles from "../Settings.module.css";

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
}

export function LanPairedList({
  devices,
  onChanged,
  toast,
}: {
  devices: PairedDevice[];
  /** 忘记成功后让父级重拉名单。 */
  onChanged: () => Promise<void> | void;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  /** 正在忘记的设备 id（空 = 没在忙）。 */
  const [forgetting, setForgetting] = useState("");

  /**
   * 忘记一台设备。
   *
   * ❗ 确认文案里必须写明它**不吊销密钥**——局域网同步是单一群组密钥模型，
   *   对方手里还有同一把密钥。不说的话用户会以为点完就断开了。
   */
  const handleForget = async (d: PairedDevice) => {
    const { confirmDialog } = await import("@/lib/confirm");
    const ok = await confirmDialog({
      title: `忘记「${d.device_name}」？`,
      message:
        "它会从本机名单里移除，并重新出现在「附近的设备」里（可以重新配对）。\n\n" +
        "⚠ 这不会吊销配对密钥：对方手里还有同一把密钥，仍然能解开本机的广播。\n" +
        "要真正断开，得在「高级」里重新生成密钥——那会把所有设备一起踢掉。",
      confirmText: "忘记",
      variant: "danger",
    });
    if (!ok) return;
    setForgetting(d.device_id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("lan_forget_device", { deviceId: d.device_id });
      toast(`已忘记「${d.device_name}」`, "success");
      await onChanged();
    } catch (e) {
      logger.warn("忘记设备失败", e);
      toast(`忘记失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setForgetting("");
    }
  };

  if (devices.length === 0) return null;

  return (
    <>
      <div className={styles.lanSectionLabel}>记住的设备</div>
      <div className={styles.lanDeviceList}>
        {devices.map((d, idx) => (
          <div
            key={d.device_id ? `device-${d.device_id}-${idx}` : `device-${idx}`}
            className={`${styles.lanDeviceItem}`}
          >
            <div
              className={`${styles.lanDeviceAvatar}`}
              style={{
                // 审查：空 device_id 时 charCodeAt 是 NaN → 兜底 0（无效色）
                background: `hsl(${((d.device_id.charCodeAt(0) || 0) * 40) % 360}, 60%, 55%)`,
              }}
            >
              {d.device_name.charAt(0).toUpperCase()}
            </div>
            <div className={`${styles.lanDeviceInfo}`}>
              <div className={`${styles.lanDeviceName}`}>{d.device_name}</div>
              {/* ❗ 这一行把「在线」与「最后同步」分开写。旧版本只有一个时间
                  配上恒亮的绿点，对方已经关机了也看不出来。 */}
              <div className={`${styles.lanDeviceTime}`}>
                {d.online ? "在线" : "离线"}
                {d.last_sync ? ` · 最后同步 ${d.last_sync}` : " · 本次运行还没同步过"}
              </div>
            </div>
            {d.online && (
              <span className={`${styles.lanDeviceOnline}`} title="刚刚还听到它的心跳">
                <span className={styles.dotOnline} />
              </span>
            )}
            <button
              className={styles.lanRefreshBtn}
              onClick={() => void handleForget(d)}
              disabled={forgetting === d.device_id}
              title="从本机名单里移除（不会吊销配对密钥）"
            >
              {forgetting === d.device_id ? "…" : "忘记"}
            </button>
          </div>
        ))}
      </div>
      {/* 🔴 必须说清楚：局域网同步是**单一群组密钥**模型，谁拿到密钥谁就能解密。
          不说的话用户会以为点了「忘记」就把对方断开了。 */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 8px" }}>
        「忘记」只清本机记录，它会重新出现在上面的「附近的设备」里、可以重新配对。
        <b>它不会吊销配对密钥</b>——对方手里还有同一把密钥，仍能解开本机的广播。
        要真正断开，得到下面「高级」里重新生成密钥（那会把<b>所有</b>设备一起踢掉）。
      </div>
    </>
  );
}
