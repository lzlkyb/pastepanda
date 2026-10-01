/**
 * LanPairingKeyPanel — 「高级：手动交换配对密钥」那一块。
 *
 * 从 `LanSyncPanel` 拆出来（规则 #7 体量红线）：这块的两个输入框、busy 态和三个
 * handler 全在自己边界内，拆出去不留跨组件引用。
 *
 * 🔴 「重新生成」是危险操作：它会把**所有已配对设备**踢下线，对方得重新粘一次密钥才能
 *   继续同步，所以必须二段确认（同 `McpServerPanel.handleRegenerate` 那把钥匙的口径）。
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/lib/confirm";
import { logger } from "@/lib/logger";
import shared from "../Settings.module.css";
import styles from "./Lan.module.css";

/** 与 `LanSyncPanel` / `McpServerPanel` 的 toast 形参同一份窄类型（它们也只发这三种） */
type ToastFn = (msg: string, type?: "success" | "error" | "info", duration?: number) => void;

export function LanPairingKeyPanel({ toast }: { toast: ToastFn }) {
  const [pairingKey, setPairingKey] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshPairingKey = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("get_lan_pairing_key");
      setPairingKey(key);
    } catch (e) {
      logger.warn("获取配对密钥失败", e);
    }
  }, []);

  useEffect(() => {
    void refreshPairingKey();
  }, [refreshPairingKey]);

  const handleRegenerateKey = async () => {
    const ok = await confirmDialog({
      title: "重新生成配对密钥？",
      message:
        "所有已配对的设备会立即断开，需要把新密钥重新粘到对方设备上才能继续同步。",
      confirmText: "重新生成",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("regenerate_lan_pairing_key");
      setPairingKey(key);
      toast("已生成新的配对密钥，其他设备需要重新粘贴此密钥才能继续同步", "success");
    } catch (e) {
      logger.warn("生成配对密钥失败", e);
      toast("生成配对密钥失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleApplyPairingKey = async () => {
    const trimmed = pairingInput.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_lan_pairing_key", { key: trimmed });
      setPairingKey(trimmed);
      setPairingInput("");
      toast("配对密钥已更新", "success");
    } catch (e) {
      logger.warn("设置配对密钥失败", e);
      const reason = typeof e === "string" && e ? e : e instanceof Error ? e.message : "";
      toast(reason ? `设置配对密钥失败: ${reason}` : "设置配对密钥失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={styles.lanAdvanced}>
      <summary className={styles.lanAdvancedHead}>高级：手动交换配对密钥</summary>
      <div className={styles.lanAdvBody}>
        <div className={styles.lanAdvDesc}>
          只有使用相同密钥的设备才会互相同步。
          <b>与旧版本设备配对时才需要它</b>；两边都是新版本就用上面的「附近的设备」。
        </div>
        <div className={styles.lanAdvRow}>
          <label className={styles.lanAdvLabel}>本机密钥</label>
          {/* ❗ `<label>` 没有 htmlFor，指不到这个 input ⇒ 读屏拿不到名字，得显式 aria-label */}
          <input
            type="text"
            readOnly
            aria-label="本机配对密钥"
            value={pairingKey}
            onFocus={(e) => e.currentTarget.select()}
            className={`${styles.lanKeyInput} ${styles.lanKeyMono}`}
          />
          <button
            type="button"
            className={shared.lanRefreshBtn}
            onClick={handleRegenerateKey}
            disabled={busy}
            title="所有已配对设备将断开，需重新配对"
          >
            🔁 重新生成
          </button>
        </div>
        <div className={styles.lanAdvRow}>
          <label className={styles.lanAdvLabel}>对端密钥</label>
          <input
            type="text"
            aria-label="对端配对密钥"
            placeholder="粘贴其他设备的配对密钥"
            value={pairingInput}
            onChange={(e) => setPairingInput(e.target.value)}
            className={`${styles.lanKeyInput} ${styles.lanKeyMono}`}
          />
          <button
            type="button"
            className={shared.lanTestBtn}
            onClick={handleApplyPairingKey}
            disabled={busy || !pairingInput.trim()}
          >
            应用
          </button>
        </div>
      </div>
    </details>
  );
}
