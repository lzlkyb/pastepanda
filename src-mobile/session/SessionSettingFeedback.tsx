import { MobileNotice } from "../ui/MobileNotice";
import { MobileToast } from "../ui/MobileToast";
import type { SessionSettingState } from "./useSessionSettings";
import ui from "../ui/MobileUi.module.css";

/** Recoverable failures stay beside their setting; ordinary receipts can finish. */
export function SessionSettingFeedback({ state, onRetry, onDismiss }: { state?: SessionSettingState; onRetry: () => void; onDismiss?: () => void }) {
  if (!state) return null;
  if (state.status === "accepted" && onDismiss) return <MobileToast placement="flow" compact {...state.feedback} onDismiss={onDismiss} />;
  return <MobileNotice compact {...state.feedback} action={state.status === "error" || state.status === "unconfirmed"
    ? <button type="button" className={ui.textButton} onClick={onRetry}>{state.status === "unconfirmed" ? "重新发送" : "重试"}</button>
    : undefined} />;
}
