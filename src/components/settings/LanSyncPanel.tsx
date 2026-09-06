import { useState, useCallback, useEffect, useRef } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import { LAN_PAIRED_CHANGED } from "@/lib/lanEvents";
import { LanNearby } from "./LanNearby";
import { LanPairedList, type PairedDevice } from "./LanPairedList";
import styles from "../Settings.module.css";

export function LanSyncPanel({ toast }: { toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void }) {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [pairingKey, setPairingKey] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  /**
   * 监听线程是否真的在跑。
   *
   * 🔴 跟开关是两件事。端口 5007 被占、或一块网卡都没能加入组播组时，
   * 监听线程会自己退出而开关仍然是开的——不把它显示出来，用户看到的
   * 就是「没报错但就是发现不了」（规则 #15.3）。初值取 true：还没探到时
   * 不该先报一个红横幅吓人。
   */
  const [running, setRunning] = useState(true);

  // 在线数 = 本次运行内听到过的那几台，跟「记住了几台」是两个数。
  const onlineCount = devices.filter((d) => d.online).length;

  // 修复：此前失败时完全静默，设备列表和绿色“监听中”状态原地不动，用户完全无感知；
  // 用 ref 记录上一次是否成功，只在从成功转失败时弹一次，避免 5s 轮询定时器下持续失败刷屏 toast
  const wasOkRef = useRef(true);
  const refreshDevices = useCallback(async () => {
    setLoading(true);
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
    finally { setLoading(false); }
  }, [toast]);

  const refreshPairingKey = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const key = await invoke<string>("get_lan_pairing_key");
      setPairingKey(key);
    } catch (e) { logger.warn("获取配对密钥失败", e); }
  }, []);

  // 窗口隐藏（hide()）时暂停设备轮询：设置页 WebView 仍存活，空转会刷屏 / 烧 CPU（规则 8）
  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!winVisible) return;
    refreshDevices();
    const timer = setInterval(refreshDevices, 5000);
    return () => clearInterval(timer);
  }, [refreshDevices, winVisible]);

  useEffect(() => {
    refreshPairingKey();
  }, [refreshPairingKey]);

  /**
   * 配对完成后立即刷名单（不等下一轮轮询）。
   *
   * ❗ 光靠上面那个 5 秒轮询不够：接受方的配对是在**收到包的那一刻**完成的，
   * 不对应任何一次点击，所以会有最长一轮的空窗——用户看到的就是
   * 「配对完成了但列表没反应」。
   *
   * 不跟 `winVisible` 绑定：事件本身是低频的（只在配对成功时发一次），
   * 而窗口隐起来时它恰好能把错过的那一次变更补上。
   */
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen(LAN_PAIRED_CHANGED, () => {
          void refreshDevices();
        });
        // effect 已在本次 setup 完成前被清理（StrictMode 重挂载 / HMR），
        // 立即取消订阅，避免监听器泄漏——同 App.tsx 里那几处的写法。
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
      {/* 🔴 开关开着但监听线程没跑 = 功能实际是死的，必须看得见。
          用横幅而不是 toast：toast 会飘走，而这个失败往往发生在设置页打开之前。 */}
      {!running && (
        <div className={styles.mcpAlert}>
          <span>
            ⚠ 监听没能启动——同网络的设备无法互相发现。
            常见原因：端口 5007 被其他程序占用，或本机网卡都无法加入组播组。
            把开关关掉再打开可重试。
          </span>
        </div>
      )}

      <div className={`${styles.lanPanelHeader}`}>
        <div className={styles.lanStatus}>
          {/* 审查：绿点跟随真实状态（无设备=灰），不再恒亮假绿 */}
          {/* ❗ 绿点跟的是**在线数**，不是记住数。两者混一起的话，
              配过一次之后绿点就永远亮着，对方早就离线也看不出来。 */}
          <div className={`${styles.lanDot}${onlineCount === 0 ? ` ${styles.off}` : ""}`} />
          <span className={`${styles.lanStatusText}`}>
            {onlineCount > 0
              ? `在线 ${onlineCount} 台`
              : "监听中 — 等待其他设备连接"}
            {devices.length > 0 && <span> · 记住了 {devices.length} 台</span>}
          </span>
        </div>
        <button className={styles.lanRefreshBtn} onClick={refreshDevices} disabled={loading}>
          {loading ? "⏳" : "🔄"} 刷新
        </button>
      </div>

      {/* 🔴 附近设备放最前：这是现在推荐的配对方式，不用交换任何东西。
          手填密钥降为「高级」里的兵底（跟旧版本配对时还需要它）。 */}
      <div className={styles.lanSectionLabel}>附近的设备</div>
      <LanNearby toast={toast} />

      <details className={styles.lanAdvanced}>
        <summary className={styles.lanAdvancedHead}>高级：手动交换配对密钥</summary>
        <div style={{ marginTop: 4, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          只有使用相同密钥的设备才会互相同步。
          <b>与旧版本设备配对时才需要它</b>；两边都是新版本就用上面的「附近的设备」。
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
      </details>

      <LanPairedList devices={devices} onChanged={refreshDevices} toast={toast} />

      {/* ❗ 这里原先写的是「同一局域网内的设备将自动发现并同步剪贴板」，
          而当时必须先手动交换密钥才看得见彼此——那句提示是错的，
          也很可能正是用户困惑的来源（2026-09-06 改）。
          现在有了招呼包，发现确实是自动的，但同步仍需配对——两件事要分开说。 */}
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
        💡 同一网络内的设备会自动出现在「附近的设备」里；配对后才会同步剪贴板
      </div>
      <button className={styles.lanTestBtn} onClick={handleSendTest}>
        🔔 发送测试消息
      </button>
    </div>
  );
}
