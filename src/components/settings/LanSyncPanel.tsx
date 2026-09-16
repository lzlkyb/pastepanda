import { useState, useCallback, useEffect, useRef } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import { LAN_PAIRED_CHANGED } from "@/lib/lanEvents";
import { LanNearby } from "./LanNearby";
import { LanPairedList, type PairedDevice } from "./LanPairedList";
import shared from "../Settings.module.css";
import styles from "./Lan.module.css";

/**
 * LanSyncPanel — 剪贴板同步主面板（P0 收口）。
 *
 * · 设备 5s 轮询；附近由 LanNearby 自管（配对中更快）
 * · LAN_PAIRED_CHANGED 只在本组件 listen 一次，并通知附近刷新
 * · 监听失败横幅带「重试监听」
 * · 发送测试后在按钮旁写送达结果，不只靠 toast
 */
export function LanSyncPanel({ toast }: { toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void }) {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairingKey, setPairingKey] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  /**
   * 监听线程是否真的在跑。
   * 🔴 跟开关是两件事。端口 5007 被占、或网卡都没能加入组播组时，
   * 监听线程会自己退出而开关仍然是开的（规则 #15.3）。
   */
  const [running, setRunning] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  /** 通知 Nearby 立刻刷新（配对完成事件） */
  const nearbyRefreshRef = useRef<(() => void) | null>(null);

  const onlineCount = devices.filter((d) => d.online).length;

  const wasOkRef = useRef(true);
  /** 手动「刷新」进行中。与 5s 轮询的 loading 分开，轮询不闪按钮。 */
  const [refreshing, setRefreshing] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [list, alive] = await Promise.all([
        invoke<PairedDevice[]>("get_lan_paired"),
        invoke<boolean>("get_lan_running"),
      ]);
      setDevices(list);
      setRunning(alive);
      wasOkRef.current = true;
    } catch (e) {
      logger.warn("获取设备列表失败", e);
      if (wasOkRef.current) {
        toast(`获取设备列表失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
      wasOkRef.current = false;
    }
  }, [toast]);

  /** 手动刷新：立刻再喊一次招呼包，再拉名单。 */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const poked = await invoke<boolean>("lan_poke_hello").catch(() => false);
      await refreshDevices();
      toast(
        poked ? "已刷新 · 已向局域网广播本机信息" : "已刷新 · 监听未运行，无法广播",
        poked ? "success" : "info",
      );
    } catch (e) {
      logger.warn("手动刷新失败", e);
      toast(`刷新失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setRefreshing(false);
    }
  }, [refreshDevices, toast]);

  const refreshPairingKey = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("get_lan_pairing_key");
      setPairingKey(key);
    } catch (e) {
      logger.warn("获取配对密钥失败", e);
    }
  }, []);

  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!winVisible) return;
    void refreshDevices();
    const timer = setInterval(() => void refreshDevices(), 5000);
    return () => clearInterval(timer);
  }, [refreshDevices, winVisible]);

  useEffect(() => {
    void refreshPairingKey();
  }, [refreshPairingKey]);

  /**
   * 配对完成后立即刷名单 + 附近列表。
   * 接受方配对发生在收包那一刻，不对应任何一次点击（规则 #15）。
   */
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen(LAN_PAIRED_CHANGED, () => {
          void refreshDevices();
          nearbyRefreshRef.current?.();
        });
        if (cancelled) off();
        else un = off;
      } catch (e) {
        logger.warn("监听设备名单变更失败", e);
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [refreshDevices]);

  const handleRetryListen = async () => {
    setRetrying(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // 关再开：与文案一致，逼后端重新 bind 5007 / 加组播
      await invoke("toggle_lan_sync", { enable: false });
      await invoke("toggle_lan_sync", { enable: true });
      await refreshDevices();
      toast("已重试启动监听", "success");
    } catch (e) {
      logger.warn("重试监听失败", e);
      toast(`重试失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setRetrying(false);
    }
  };

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
    } finally {
      setPairingBusy(false);
    }
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
      const reason = typeof e === "string" && e ? e : e instanceof Error ? e.message : "";
      toast(reason ? `设置配对密钥失败: ${reason}` : "设置配对密钥失败", "error");
    } finally {
      setPairingBusy(false);
    }
  };

  const handleSendTest = async () => {
    setTestBusy(true);
    setTestMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_lan_test");
      const n = onlineCount;
      const msg =
        n > 0
          ? `已发出 · 当前在线 ${n} 台（若对方在线应收到「测试同步」）`
          : "已发出 · 当前没有在线设备，对方可能收不到";
      setTestMsg(msg);
      toast("已发送测试同步消息", "success");
    } catch (e) {
      logger.warn("发送测试失败", e);
      const reason = e instanceof Error ? e.message : String(e);
      setTestMsg("发送失败 — 见错误提示");
      toast(`发送测试消息失败：${reason}`, "error");
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className={shared.lanPanel}>
      {!running && (
        <div className={shared.mcpAlert}>
          <div className={styles.lanAlertBody}>
            <div>
              <b>监听没能启动</b> — 同网络的设备无法互相发现。
              <div className={styles.lanAlertHint}>
                常见原因：端口 <code>5007</code> 被其他程序占用，或本机网卡都无法加入组播组。
              </div>
            </div>
            <button
              type="button"
              className={shared.lanRefreshBtn}
              onClick={handleRetryListen}
              disabled={retrying}
            >
              {retrying ? "重试中…" : "重试监听"}
            </button>
          </div>
        </div>
      )}

      <div className={shared.lanPanelHeader}>
        <div className={shared.lanStatus}>
          <div className={`${shared.lanDot}${onlineCount === 0 ? ` ${shared.off}` : ""}`} />
          <span className={shared.lanStatusText}>
            {onlineCount > 0
              ? `在线 ${onlineCount} 台`
              : running
                ? "监听中 — 等待其他设备连接"
                : "监听未启动"}
            {devices.length > 0 && <span> · 记住了 {devices.length} 台</span>}
          </span>
        </div>
        <button
          className={shared.lanRefreshBtn}
          onClick={() => void refreshNow()}
          disabled={refreshing}
          title="立刻向局域网广播并拉取最新设备名单"
        >
          {refreshing ? "⏳ 刷新中…" : "🔄 刷新"}
        </button>
      </div>

      <div className={styles.lanSectionLabel}>附近的设备</div>
      <LanNearby
        toast={toast}
        onReady={(refresh) => {
          nearbyRefreshRef.current = refresh;
        }}
      />

      <details className={styles.lanAdvanced}>
        <summary className={styles.lanAdvancedHead}>高级：手动交换配对密钥</summary>
        <div className={styles.lanAdvBody}>
          <div className={styles.lanAdvDesc}>
            只有使用相同密钥的设备才会互相同步。
            <b>与旧版本设备配对时才需要它</b>；两边都是新版本就用上面的「附近的设备」。
          </div>
          <div className={styles.lanAdvRow}>
            <label className={styles.lanAdvLabel}>本机密钥</label>
            <input
              type="text"
              readOnly
              value={pairingKey}
              onFocus={(e) => e.currentTarget.select()}
              className={`${styles.lanKeyInput} ${styles.lanKeyMono}`}
            />
            <button
              type="button"
              className={shared.lanRefreshBtn}
              onClick={handleRegenerateKey}
              disabled={pairingBusy}
              title="所有已配对设备将断开，需重新配对"
            >
              🔁 重新生成
            </button>
          </div>
          <div className={styles.lanAdvRow}>
            <label className={styles.lanAdvLabel}>对端密钥</label>
            <input
              type="text"
              placeholder="粘贴其他设备的配对密钥"
              value={pairingInput}
              onChange={(e) => setPairingInput(e.target.value)}
              className={`${styles.lanKeyInput} ${styles.lanKeyMono}`}
            />
            <button
              type="button"
              className={shared.lanTestBtn}
              onClick={handleApplyPairingKey}
              disabled={pairingBusy || !pairingInput.trim()}
            >
              应用
            </button>
          </div>
        </div>
      </details>

      <LanPairedList devices={devices} onChanged={refreshDevices} toast={toast} />

      <div className={styles.lanTip}>
        💡 同一网络内的设备会自动出现在「附近的设备」里；配对后才会同步剪贴板
      </div>
      <div className={styles.lanTestRow}>
        <button
          type="button"
          className={shared.lanTestBtn}
          onClick={handleSendTest}
          disabled={testBusy || !running}
        >
          {testBusy ? "发送中…" : "🔔 发送测试消息"}
        </button>
        {testMsg && (
          <span
            className={`${styles.lanTestMsg}${testMsg.startsWith("已发出") ? ` ${styles.lanTestOk}` : ""}`}
          >
            {testMsg}
          </span>
        )}
      </div>
    </div>
  );
}
