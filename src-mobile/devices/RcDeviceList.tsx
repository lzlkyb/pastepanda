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
}: {
  targets: RcTargetDevice[];
  reachability: Record<string, { state: "checking" | "reachable" | "unreachable" | "error"; checkedAt?: number }>;
  channelUp: boolean | null;
  onPick: (nodeId: string) => void;
}) {
  return (
    <>
      {targets.map((target) => {
        const status = rcDeviceStatus(target.presence, reachability[target.node_id], channelUp);
        const path = target.last_path ? PATH_LABEL[target.last_path] : "";
        return (
          <button
            key={target.node_id}
            type="button"
            className={styles.deviceCard}
            onClick={() => onPick(target.node_id)}
          >
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
                {target.denied && " · 已拒绝"}
              </span>
            </span>
            <ChevronRight size={18} className={styles.chevron} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}
