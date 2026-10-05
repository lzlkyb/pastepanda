import { rcDeviceKind, rcDeviceTypeLabel } from "@/lib/utils";
import styles from "./RcDeviceIcon.module.css";

export function RcDeviceIcon({ os, size = 24, className }: {
  os?: string | null;
  size?: number;
  className?: string;
}) {
  const kind = rcDeviceKind(os);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="currentColor"
      className={`${styles.icon}${className ? ` ${className}` : ""}`}
      role="img" aria-label={kind === "unknown" ? "设备类型尚未获取" : rcDeviceTypeLabel(os)} data-device-kind={kind}>
      {kind === "phone" ? <>
        <rect x="16" y="5" width="32" height="54" rx="5" />
        <rect x="20" y="9" width="24" height="46" rx="3" className={styles.screen} />
        <rect x="27" y="10" width="10" height="3" rx="1.5" />
        <rect x="27" y="50" width="10" height="2" rx="1" />
      </> : kind === "tablet" ? <>
        <rect x="4" y="12" width="56" height="40" rx="5" />
        <rect x="9" y="16" width="46" height="32" rx="2" className={styles.screen} />
        <circle cx="6.5" cy="32" r="1" className={styles.screen} />
      </> : kind === "computer" ? <>
        <rect x="3" y="8" width="58" height="38" rx="4" />
        <rect x="7" y="12" width="50" height="29" rx="1" className={styles.screen} />
        <path d="M27 46h10l3 10H24Z" />
        <rect x="17" y="56" width="30" height="3" rx="1.5" />
      </> : <>
        <rect x="10" y="8" width="44" height="48" rx="7" />
        <rect x="14" y="12" width="36" height="40" rx="3" className={styles.screen} />
        <path d="M26 26a6 6 0 1 1 9 5c-3 2-3 3-3 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="43" r="2" />
      </>}
    </svg>
  );
}
