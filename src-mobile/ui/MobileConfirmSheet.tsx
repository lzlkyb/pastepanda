import { useRef } from "react";
import { TriangleAlert, Trash2 } from "lucide-react";
import { MobileSheet } from "./MobileSheet";
import { MobileNotice } from "./MobileNotice";
import { MobileFeedbackSlot } from "./MobileFeedbackSlot";
import ui from "./MobileUi.module.css";
import styles from "./MobileConfirmSheet.module.css";

/** Protected decisions start on the safe action; callers own the operation and its result. */
export function MobileConfirmSheet({ open, title, description, onCancel, onConfirm, confirmLabel, cancelLabel = "取消", busy = false, error, danger = true }: {
  open: boolean; title: string; description: string; onCancel: () => void; onConfirm: () => void;
  confirmLabel: string; cancelLabel?: string; busy?: boolean; error?: string | null; danger?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const close = () => { if (!busy) onCancel(); };
  const Icon = danger ? Trash2 : TriangleAlert;
  return <MobileSheet open={open} title={title} description={description} onClose={close} initialFocusRef={cancel} backPriority={20}
    footer={<MobileFeedbackSlot>{error ? <MobileNotice error title="操作尚未完成" detail={error} /> : null}</MobileFeedbackSlot>}
    actions={<div className={`${ui.stack} ${styles.actions}`}>
      <button ref={cancel} type="button" className={ui.secondary} disabled={busy} onClick={close}>{cancelLabel}</button>
      <button type="button" className={danger ? ui.danger : ui.primary} disabled={busy} onClick={() => { if (!busy) onConfirm(); }}>{busy ? "正在处理…" : confirmLabel}</button>
    </div>}>
    <span className={danger ? styles.dangerIcon : styles.warningIcon} aria-hidden="true"><Icon size={28} /></span>
  </MobileSheet>;
}
