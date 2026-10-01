/**
 * RcDeviceList — 设备卡列表（§1 列表态）。
 *
 * 状态词与色分复用 lib/utils 的 rcDeviceStatus（与桌面侧栏同一措辞，L1 说
 * 用户的话，不另造词）。行内零按钮（桌面 A2 同判）：点卡 = 选中，连接只走
 * 底部动作面板（设计稿 §0 D3）。
 */
import type { RcTargetDevice } from "@/lib/api/rc";
import { rcDeviceStatus } from "@/lib/utils";
import styles from "./RcDevices.module.css";

const PATH_LABEL: Record<string, string> = {
  lan: "局域网",
  direct: "P2P 直连",
  relay: "中继",
};

export function RcDeviceList({
  targets,
  reachability,
  channelUp,
  onPick,
}: {
  targets: RcTargetDevice[];
  reachability: Record<string, { state: "checking" | "reachable" | "unreachable" | "error"; checkedAt?: number }>;
  channelUp: boolean | null;
  onPick: (nodeId: string) => void;
}) {
  return (
    <>
      {targets.map((t) => {
        const st = rcDeviceStatus(t.presence, reachability[t.node_id], channelUp);
        const path = t.last_path ? PATH_LABEL[t.last_path] : "";
        return (
          <button
            key={t.node_id}
            type="button"
            className={styles.deviceCard}
            onClick={() => onPick(t.node_id)}
          >
            <div className={styles.deviceName}>
              <span className={`${styles.dot} ${st.tone === "ok" ? styles.dotOk : st.tone === "checking" ? styles.dotChecking : styles.dotUnknown}`} aria-hidden="true" />
              {t.display_name || t.name}
              {t.denied && <span className={`${styles.selfTag} ${styles.noticeError}`}>已拒绝</span>}
            </div>
            <div className={styles.deviceSub}>
              {st.label}
              {path && ` · 上次${path}`}
            </div>
          </button>
        );
      })}
    </>
  );
}
