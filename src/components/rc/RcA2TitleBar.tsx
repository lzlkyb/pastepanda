import { MonitorUp, RefreshCw, Radio } from "lucide-react";
import styles from "./RemoteComputerA2.module.css";

export function RcA2TitleBar({
  channelUp,
  busy,
  probing,
  sessionLabel,
  onProbe,
  onStartChannel,
}: {
  channelUp: boolean;
  busy: boolean;
  probing: boolean;
  sessionLabel: string;
  onProbe: () => void;
  onStartChannel: () => void;
}) {
  return (
    <header className={styles.titleBar} data-tauri-drag-region="">
      <span className={styles.brandIcon} aria-hidden="true">
        <MonitorUp size={17} />
      </span>
      <div className={styles.brandCopy}>
        <strong>PastePanda 远程电脑</strong>
        <span>{sessionLabel || "选择一台设备开始工作"}</span>
      </div>
      <div className={styles.titleActions}>
        <button type="button" className={styles.secondaryButton} disabled={probing} onClick={onProbe}>
          <RefreshCw size={14} aria-hidden="true" />
          {probing ? "检测中" : "检测设备"}
        </button>
        <button
          type="button"
          className={channelUp ? styles.channelReady : styles.secondaryButton}
          disabled={busy || channelUp}
          onClick={onStartChannel}
        >
          <Radio size={14} aria-hidden="true" />
          {channelUp ? "远程通道已启动" : "启动远程通道"}
        </button>
      </div>
    </header>
  );
}
