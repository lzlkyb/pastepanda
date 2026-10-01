import { Play } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { capabilityLabel } from "@/lib/rcRequest";
import styles from "./RemoteComputerA2.module.css";

/** 详情区的默认连接动作；另一种模式由旁边的常驻按钮直达。 */
export function RcA2ConnectAction({
  targetId,
  name,
  cap,
  denied = false,
  disabled = false,
  disabledReason = "",
  onConnect,
}: {
  targetId: string;
  name: string;
  cap: RcCapability;
  denied?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onConnect: (id: string, capability: RcCapability) => void;
}) {
  const title = disabled
    ? disabledReason
    : denied
      ? `这台设备已被你禁止远程本机；你仍可主动连接。将以「${capabilityLabel(cap)}」发起`
      : `将以「${capabilityLabel(cap)}」发起：连接${name}`;
  const label = cap === "control" ? "连接并控制" : "连接并只看";

  return (
    <button
      type="button"
      className={denied ? styles.connectButtonSec : styles.connectButton}
      aria-label={`连接${name}`}
      title={title}
      disabled={disabled}
      onClick={() => onConnect(targetId, cap)}
    >
      <Play size={14} aria-hidden="true" />
      {denied ? `仍可${label}` : label}
    </button>
  );
}
