import { ArrowLeft, Monitor } from "lucide-react";
import { RcConnectionBadge } from "./RcConnectionDetails";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";
import styles from "./RcMobileSession.module.css";

export function RcSessionHeader({ title, subtitle, info, onBack, onScreen, onDetails }: {
  title: string; subtitle?: string; info: MobileConnectionInfo; onBack: () => void; onScreen: () => void; onDetails: () => void;
}) {
  return <header className={styles.statusRow}>
    <button type="button" className={styles.headerButton} onClick={onBack} aria-label="返回设备"><ArrowLeft size={20} aria-hidden="true" /></button>
    <span className={styles.headerIdentity}><span className={styles.statusTitle}>{title}</span>{subtitle && <span className={styles.headerSubtitle}>{subtitle}</span>}</span>
    <RcConnectionBadge info={info} onOpen={onDetails} />
    <button type="button" className={styles.headerButton} onClick={onScreen} aria-label="画面与画质"><Monitor size={20} aria-hidden="true" /></button>
  </header>;
}
