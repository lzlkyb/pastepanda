import { MobileNotice } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import type { useSessionClipboard } from "./useSessionClipboard";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

export function SessionClipboardPanel({ clipboard, canControl }: {
  clipboard: ReturnType<typeof useSessionClipboard>;
  canControl: boolean;
}) {
  const feedback = clipboard.feedback;
  return <MobileSheet open={clipboard.clipOpen} title="剪贴板" description="在手机与电脑之间交换剪贴板文字。" onClose={clipboard.toggleClip}>
    {feedback && <MobileNotice {...feedback} onDismiss={clipboard.busy ? undefined : clipboard.dismiss}
      action={feedback.tone === "error" && <button type="button" className={ui.textButton} disabled={!canControl || clipboard.busy} onClick={() => void clipboard.retry()}>重试</button>} />}
    <div className={styles.panelActions}>
      <button type="button" className={ui.primary} disabled={clipboard.busy || !canControl} onClick={() => void clipboard.push()}>推到电脑</button>
      <button type="button" className={ui.secondary} disabled={clipboard.busy || !canControl} onClick={() => void clipboard.pull()}>取到手机</button>
    </div>
  </MobileSheet>;
}
