import { RcDeviceMeta } from "@/components/rc/RcDeviceMeta";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcDeviceIcon } from "@/components/rc/RcDeviceIcon";
import { ChevronRight } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import { rcDeviceStatus } from "@/lib/utils";
import styles from "./RcDevices.module.css";

const PATH_LABEL: Record<string, string> = { lan: "局域网", direct: "P2P 直连", relay: "中继" };
export function RcDeviceList({
  targets,
  reachability,
  channelUp,
  onPick,
  onConnect,
  connectBlocked = false,
  connectingPeer,
  detailsBlocked = false,
}: {
  targets: RcTargetDevice[];
  reachability: Record<string, { state: "checking" | "reachable" | "unreachable" | "error"; checkedAt?: number }>;
  channelUp: boolean | null;
  onPick: (nodeId: string) => void;
  onConnect?: (target: RcTargetDevice) => void;
  connectBlocked?: boolean;
  connectingPeer?: string;
  detailsBlocked?: boolean;
}) {
  return (
    <>
      {targets.map((target) => {
        const status = rcDeviceStatus(target.presence, reachability[target.node_id], channelUp);
        const path = target.last_path ? PATH_LABEL[target.last_path] : "";
        return (
          <div
            key={target.node_id}
            className={styles.deviceCard}
          >
            <button type="button" className={styles.deviceDetails} disabled={detailsBlocked} onClick={() => onPick(target.node_id)}
              aria-label={`查看 ${rcDisplayName(target, "新设备")} 详情`}>
            <span className={`${styles.deviceIcon} ${status.tone === "ok" ? styles.deviceIconOnline : ""}`}>
              <RcDeviceIcon os={target.os} size={38} />
            </span>
            <span className={styles.deviceText}>
              <strong>{rcDisplayName(target, "新设备")}</strong>
              <RcDeviceMeta os={target.os} className={styles.deviceType} />
              <span className={styles.deviceSub}>
                <span
                  className={`${styles.dot} ${status.tone === "ok" ? styles.dotOk : status.tone === "checking" ? styles.dotChecking : styles.dotUnknown}`}
                  aria-hidden="true"
                />
                {status.label}
                {path && ` · 上次${path}`}
                {target.denied && " · 已禁止连接本机"}
              </span>
            </span>
            <ChevronRight size={18} className={styles.chevron} aria-hidden="true" />
            </button>
            {onConnect && target.source !== "sync" && (
              <button type="button" className={styles.connectButton} disabled={connectBlocked}
                aria-label={`${connectingPeer === target.node_id ? "正在连接" : "连接"} ${rcDisplayName(target, "新设备")}`}
                onClick={() => onConnect(target)}>
                {connectingPeer === target.node_id ? "连接中…" : "连接"}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
