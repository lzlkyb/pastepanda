import { useState, useCallback, useEffect } from "react";
import { logger } from "@/lib/logger";
import styles from "../Settings.module.css";

interface LanDevice { device_id: string; device_name: string; last_seen: string; }

export function LanSyncPanel({ toast }: { toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void }) {
  const [devices, setDevices] = useState<LanDevice[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshDevices = useCallback(async () => {
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<LanDevice[]>("get_lan_devices");
      setDevices(list);
    } catch (e) { logger.warn("获取设备列表失败", e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refreshDevices();
    const timer = setInterval(refreshDevices, 5000);
    return () => clearInterval(timer);
  }, [refreshDevices]);

  const handleSendTest = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_lan_test");
      toast("已发送测试同步消息", "success");
    } catch (e) { logger.warn("发送测试失败", e); }
  };

  return (
    <div className={styles.lanPanel}>
      <div className={`${styles.lanPanelHeader}`}>
        <div className={styles.lanStatus}>
          <div className={styles.lanDot} />
          <span className={`${styles.lanStatusText}`}>监听中 — 等待其他设备连接</span>
        </div>
        <button className={styles.lanRefreshBtn} onClick={refreshDevices} disabled={loading}>
          {loading ? "⏳" : "🔄"} 刷新
        </button>
      </div>

      {devices.length > 0 && (
        <div className={styles.lanDeviceList}>
          {devices.map((d, idx) => (
            <div key={d.device_id ? `device-${d.device_id}-${idx}` : `device-${idx}`} className={`${styles.lanDeviceItem}`}>
              <div className={`${styles.lanDeviceAvatar}`} style={{
                background: `hsl(${d.device_id.charCodeAt(0) * 40 % 360}, 60%, 55%)`,
              }}>
                {d.device_name.charAt(0).toUpperCase()}
              </div>
              <div className={`${styles.lanDeviceInfo}`}>
                <div className={`${styles.lanDeviceName}`}>{d.device_name}</div>
                <div className={`${styles.lanDeviceTime}`}>{d.last_seen}</div>
              </div>
              <span className={`${styles.lanDeviceOnline}`} title="在线"><span className={styles.dotOnline} /></span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
        💡 同一局域网内的设备将自动发现并同步剪贴板
        {devices.length > 0 && <span> · 已发现 {devices.length} 台设备</span>}
      </div>
      <button className={styles.lanTestBtn} onClick={handleSendTest}>
        🔔 发送测试消息
      </button>
    </div>
  );
}
