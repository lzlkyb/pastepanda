import { rcDeviceKind, rcDeviceTypeLabel } from "@/lib/utils";
import styles from "./RcDeviceIcon.module.css";

/** Type stays visible; connection state belongs on its own line. */
export function RcDeviceMeta({ os, className }: { os?: string | null; className?: string }) {
  const platform = rcDeviceKind(os) === "unknown" ? "类型待识别" : (os ?? "").trim();
  return (
    <span className={`${styles.meta}${className ? ` ${className}` : ""}`}>
      <span className={styles.type}>{rcDeviceTypeLabel(os)}</span> · {platform}
    </span>
  );
}
