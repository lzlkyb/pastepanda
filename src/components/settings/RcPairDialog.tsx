import { useEffect, useRef, useState } from "react";
import { Keyboard, QrCode, Radar, RefreshCw } from "lucide-react";
import { NEARBY_IDLE_POLL_MS, NEARBY_POLL_MS, useRcNearbyPair } from "@/hooks/useRcNearbyPair";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcConnectionShell } from "./RcConnectionShell";
import { RcShortPairPane } from "./RcShortPairPane";
import { RcNearbyList } from "./RcNearbyList";
import { RcPairPin } from "./RcPairPin";
import styles from "./RcConnect.module.css";

export type RcPairTab = "scan" | "code" | "nearby";
const TABS = [{ id: "scan", label: "手机扫码", icon: QrCode }, { id: "code", label: "配对码", icon: Keyboard }, { id: "nearby", label: "附近设备", icon: Radar }] as const;

/** 三种入口共用一个向导；非附近页只低频观察必须核对的来访请求。 */
export function RcPairDialog({ rc, toast, onClose, onPairAccepted, initialTab = "scan" }: {
  rc: UseRc; toast: ToastFn; onClose: () => void; onPairAccepted?: (id: string) => void; initialTab?: RcPairTab;
}) {
  const [tab, setTab] = useState<RcPairTab>(initialTab);
  const near = useRcNearbyPair({ idlePollMs: tab === "nearby" ? NEARBY_POLL_MS : NEARBY_IDLE_POLL_MS });
  const [ended, setEnded] = useState(false);
  const wasPairing = useRef(false);
  const completed = useRef(false);
  const accepted = async (id: string, name: string) => {
    if (completed.current) return;
    completed.current = true;
    await rc.refreshTargets();
    toast(`已与「${name || "新设备"}」配对，设备已加入列表`, "success");
    onPairAccepted?.(id);
    onClose();
  };
  useEffect(() => {
    if (near.done) void accepted(near.done.peer_id, near.done.peer_name);
    // 只处理这一轮的完成状态，回调引用变化不能重复完成。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near.done]);
  useEffect(() => {
    if (wasPairing.current && !near.pair && !near.done) setEnded(true);
    wasPairing.current = Boolean(near.pair);
  }, [near.pair, near.done]);
  const close = () => { if (near.pair) void near.cancel(); onClose(); };
  const confirm = async () => {
    try {
      const result = await near.confirm();
      if (result.state === "gone") setEnded(true);
      if (result.state === "committed") void accepted(result.peer_id, result.peer_name);
    } catch (error) { toast(`确认失败：${String(error)}`, "error"); }
  };
  return <RcConnectionShell title="添加设备" subtitle="选择一种方式，配对后设备会保留在列表中。" onClose={close}>
    <div className={styles.tabs} role="tablist" aria-label="添加设备方式" onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    }}>
      {TABS.map(({ id, label, icon: Icon }) => <button key={id} id={`rc-tab-${id}`} type="button" role="tab"
        tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="rc-pair-panel" disabled={Boolean(near.pair)} onClick={() => { setTab(id); setEnded(false); }}><Icon size={16} aria-hidden="true" />{label}</button>)}
    </div>
    <div id="rc-pair-panel" role="tabpanel" aria-labelledby={`rc-tab-${tab}`} className={styles.body}>
      {near.pair ? <RcPairPin prompt={near.pair} busy={near.busy} onConfirm={() => void confirm()} onCancel={() => void near.cancel()} />
        : tab !== "nearby" ? <RcShortPairPane key={tab} scan={tab === "scan"} toast={toast} onPaired={(id, name) => void accepted(id, name)} />
        : <>
          <div className={styles.nearHead}><p className={styles.hint}>发现同一 Wi-Fi / 局域网里的未配对设备。</p><button type="button" className={styles.button} disabled={near.busy} onClick={() => void near.refresh()}><RefreshCw size={14} />重新查找</button></div>
          {ended && <div className={`${styles.status} ${styles.error}`} role="alert">这次配对已结束，对方取消或确认超时。可以重新发起。</div>}
          {near.error ? <div className={`${styles.status} ${styles.error}`} role="alert">附近设备读取失败，请重新查找。{near.error}</div>
            : near.loading ? <div className={styles.empty} role="status">正在查找附近设备…</div>
            : near.neighbors.length === 0 ? <div className={styles.empty}><Radar size={36} aria-hidden="true" /><h3>暂未发现附近设备</h3><p className={styles.hint}>让另一台电脑打开最新版 PastePanda，<br />并连接同一个 Wi-Fi 或局域网。</p><div className={styles.actions}><button type="button" className={styles.button} onClick={() => setTab("code")}>改用配对码</button></div></div>
            : <RcNearbyList neighbors={near.neighbors} busy={near.busy} onPair={(device) => { setEnded(false); void near.startPair(device.node_id).catch((error) => toast(`发起配对失败：${String(error)}`, "error")); }} />}
        </>}
    </div>
    <div className={styles.footer}>配对只用于识别设备。远程控制和文件接收仍按对方的权限设置确认。</div>
  </RcConnectionShell>;
}
