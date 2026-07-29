import { useState, useCallback, useEffect, useRef } from "react";
import { logger } from "@/lib/logger";
import styles from "../Settings.module.css";

interface LanDevice { device_id: string; device_name: string; last_seen: string; }

export function LanSyncPanel({ toast }: { toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void }) {
  const [devices, setDevices] = useState<LanDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [pairingKey, setPairingKey] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  // 修复：此前失败时完全静默，设备列表和绿色“监听中”状态原地不动，用户完全无感知；
  // 用 ref 记录上一次是否成功，只在从成功转失败时弹一次，避免 5s 轮询定时器下持续失败刷屏 toast
  const wasOkRef = useRef(true);
  const refreshDevices = useCallback(async () => {
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<LanDevice[]>("get_lan_devices");
      setDevices(list);
      wasOkRef.current = true;
    } catch (e) {
      logger.warn("获取设备列表失败", e);
      if (wasOkRef.current) {
        toast(`获取设备列表失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
      wasOkRef.current = false;
    }
    finally { setLoading(false); }
  }, [toast]);

  const refreshPairingKey = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("get_lan_pairing_key");
      setPairingKey(key);
    } catch (e) { logger.warn("获取配对密钥失败", e); }
  }, []);

  useEffect(() => {
    refreshDevices();
    const timer = setInterval(refreshDevices, 5000);
    return () => clearInterval(timer);
  }, [refreshDevices]);

  useEffect(() => {
    refreshPairingKey();
  }, [refreshPairingKey]);

  const handleRegenerateKey = async () => {
    setPairingBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("regenerate_lan_pairing_key");
      setPairingKey(key);
      toast("已生成新的配对密钥，其他设备需要重新粘贴此密钥才能继续同步", "success");
    } catch (e) {
      logger.warn("生成配对密钥失败", e);
      toast("生成配对密钥失败", "error");
    } finally { setPairingBusy(false); }
  };

  const handleApplyPairingKey = async () => {
    const trimmed = pairingInput.trim();
    if (!trimmed) return;
    setPairingBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_lan_pairing_key", { key: trimmed });
      setPairingKey(trimmed);
      setPairingInput("");
      toast("配对密钥已更新", "success");
    } catch (e) {
      logger.warn("设置配对密钥失败", e);
      // 展示后端的具体拒绝原因（如密钥强度不足 — 修复 M14 后由后端校验返回）
      const reason = typeof e === "string" && e ? e : e instanceof Error ? e.message : "";
      toast(reason ? `设置配对密钥失败: ${reason}` : "设置配对密钥失败", "error");
    } finally { setPairingBusy(false); }
  };

  const handleSendTest = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_lan_test");
      toast("已发送测试同步消息", "success");
    } catch (e) {
      logger.warn("发送测试失败", e);
      // 修复：这个按钮存在的唯一目的就是诊断同步故障，静默失败是最讽刺的 bug，必须补上失败提示
      toast(`发送测试消息失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
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

      <div style={{ marginTop: 4, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          配对密钥（只有使用相同密钥的设备才会互相同步，请将此密钥手动拷贝到其他设备）
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            readOnly
            value={pairingKey}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              flex: 1,
              fontFamily: "monospace",
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border-color, #ccc)",
              background: "var(--bg-secondary, transparent)",
              color: "var(--text-primary)",
            }}
          />
          <button className={styles.lanRefreshBtn} onClick={handleRegenerateKey} disabled={pairingBusy}>
            🔁 重新生成
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            placeholder="粘贴其他设备的配对密钥"
            value={pairingInput}
            onChange={(e) => setPairingInput(e.target.value)}
            style={{
              flex: 1,
              fontFamily: "monospace",
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--border-color, #ccc)",
              background: "var(--bg-secondary, transparent)",
              color: "var(--text-primary)",
            }}
          />
          <button
            className={styles.lanTestBtn}
            onClick={handleApplyPairingKey}
            disabled={pairingBusy || !pairingInput.trim()}
          >
            应用
          </button>
        </div>
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
