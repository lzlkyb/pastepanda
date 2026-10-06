import { MobileNotice } from "../ui/MobileNotice";
import type { SessionSettingState } from "./useSessionSettings";
import ui from "../ui/MobileUi.module.css";

/** The full outcome stays beside the setting that triggered it. */
export function SessionSettingFeedback({ state, onRetry }: { state?: SessionSettingState; onRetry: () => void }) {
  if (!state) return null;
  return <MobileNotice compact {...state.feedback} action={state.status === "error" || state.status === "unconfirmed"
    ? <button type="button" className={ui.textButton} onClick={onRetry}>{state.status === "unconfirmed" ? "重新发送" : "重试"}</button>
    : undefined} />;
}
