import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import styles from "../Settings.module.css";
import { useWindowVisible } from "@/hooks/useWindowVisible";

interface NearbyDevice {
  device_id: string;
  device_name: string;
  last_seen: number;
}

interface PairState {
  peer_id: string;
  peer_name: string;
  /** 协商完成前为空串 */
  pin: string;
  role: "initiator" | "responder";
  confirmed: boolean;
}

/** 轮询间隔：配对要及时弹框，比设备列表快一些。 */
const POLL_MS = 2000;

/**
 * 附近设备 + 配对核对。
 *
 * 设计稿：`design/PastePanda-局域网同步-附近设备配对-设计稿.html`
 *
 * # 🔴 两端都要看到同一个 6 位数字
 *
 * 它不是密码，是协商出来那把密钥的**指纹**。中间人插足会让两端
 * 算出不同的值 → 数字对不上 → 用户当场发现。所以：
 * - 数字要够大够清楚，拉开字距方便逐位比
 * - 确认按钮**不预选**，不能让人回车就过
 * - 文案直接写“两边不一样就点取消”
 *
 * 用户不看就点确认是真实弱点，这里不假装能消除它。
 */
export function LanNearby({ toast }: {
  /** 与 `LanSyncPanel` 同一个窄类型（只用得到 success/error）。
   *  不用全局 `ToastFn`：那个包含 `"loading"` 等更宽的取值，
   *  父组件传下来的函数接不住，会在这里报类型不兼容。 */
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [nearby, setNearby] = useState<NearbyDevice[]>([]);
  const [pair, setPair] = useState<PairState | null>(null);
  const [busy, setBusy] = useState(false);
  /** 窗口隐藏时停轮询（规则 #8）。 */
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        invoke<NearbyDevice[]>("get_lan_nearby"),
        invoke<PairState | null>("get_lan_pair_state"),
      ]);
      if (!aliveRef.current) return;
      setNearby(list);
      setPair(st);
    } catch (e) {
      // 不弹 toast：这是 2 秒一次的轮询，失败弹一次就是刷屏。
      logger.warn("获取附近设备失败", e);
    }
  }, []);

  // ❗ 窗口不可见就停（规则 #8）。本面板 2 秒一轮，是全应用最密的轮询；
  //   不关的话用户把窗口最小化后它依然每 2 秒进一次后端。
  //   `useKbSync`（5 秒）与 `KbSyncStatusBar`（10 秒）早就是这么写的，
  //   这里是把它们补齐。
  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!winVisible) return;
    aliveRef.current = true;
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(t);
    };
  }, [refresh, winVisible]);

  const start = async (d: NearbyDevice) => {
    setBusy(true);
    try {
      await invoke("lan_pair_start", { deviceId: d.device_id });
      await refresh();
    } catch (e) {
      toast(typeof e === "string" ? e : "发起配对失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await invoke("lan_pair_confirm");
      toast("已确认，正在完成配对", "success");
      await refresh();
    } catch (e) {
      toast(typeof e === "string" ? e : "确认失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await invoke("lan_pair_cancel");
      await refresh();
    } catch (e) {
      logger.warn("取消配对失败", e);
    }
  };

  // 配对进行中：盖住列表，只让用户干一件事——核对数字。
  if (pair) {
    const waiting = !pair.pin;
    return (
      <div className={styles.lanPairBox}>
        {waiting ? (
          <>
            <div className={styles.lanPairTitle}>
              {pair.role === "initiator"
                ? `正在连接「${pair.peer_name}」…`
                : `「${pair.peer_name}」想与本机同步剪贴板`}
            </div>
            <div className={styles.lanPairHint}>正在协商安全码…</div>
          </>
        ) : (
          <>
            <div className={styles.lanPairTitle}>
              {pair.role === "initiator"
                ? `与「${pair.peer_name}」配对`
                : `「${pair.peer_name}」想与本机同步剪贴板`}
            </div>
            <div className={styles.lanPairPin}>{pair.pin}</div>
            <div className={styles.lanPairHint}>
              确认<b>另一台设备</b>上显示的是同一串数字。
              <br />
              两边不一样就点取消——那意味着有人在中间插足。
            </div>
            {pair.role === "responder" && (
              <div className={styles.lanPairWarn}>
                ⚠ 确认后，本机会改用对方的配对密钥；
                如果你之前已和别的设备配过，那些设备会断开。
              </div>
            )}
            <div className={styles.lanPairBtns}>
              <button className="btn-secondary" onClick={cancel} disabled={busy}>
                不一样，取消
              </button>
              {/* 确认已点过就变成等待态，避免用户反复点 */}
              <button className="btn-primary" onClick={confirm} disabled={busy || pair.confirmed}>
                {pair.confirmed ? "已确认，等对方…" : "一样，确认"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (nearby.length === 0) {
    return (
      <div className={styles.lanNearbyEmpty}>
        没有发现附近的设备。确认另一台也开了局域网同步、且在同一个网络里。
      </div>
    );
  }

  return (
    <div className={styles.lanNearbyList}>
      {nearby.map((d) => (
        <div key={d.device_id} className={styles.lanNearbyItem}>
          <div
            className={styles.lanDeviceAvatar}
            style={{ background: `hsl(${(d.device_id.charCodeAt(0) || 0) * 40 % 360}, 60%, 55%)` }}
          >
            {(d.device_name || "?").charAt(0).toUpperCase()}
          </div>
          <div className={styles.lanDeviceInfo}>
            <div className={styles.lanDeviceName}>{d.device_name || "未命名设备"}</div>
            <div className={styles.lanDeviceTime}>未配对</div>
          </div>
          <button className="btn-primary" disabled={busy} onClick={() => start(d)}>
            配对
          </button>
        </div>
      ))}
    </div>
  );
}
