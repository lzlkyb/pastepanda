import { MobileToast } from "../ui/MobileToast";
import type { DirectSwitchToast } from "./useDirectSwitchToast";
import type { AutoSuggestToast } from "./useAutoSuggestToast";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

/** A panel pauses notice reading time; results stay session-owned until visible again. */
export function SessionConnectionNotices({ direct, suggestion, blocked }: {
  direct: DirectSwitchToast | null;
  suggestion: AutoSuggestToast | null;
  blocked: boolean;
}) {
  if (blocked || (!direct && !suggestion)) return null;
  return <div className={styles.connectionNotices}>
    {direct && <MobileToast placement="flow" compact tone="success" title={direct.title} detail={direct.detail} onDismiss={direct.dismiss} />}
    {suggestion && <MobileToast placement="flow" compact tone="info" title={suggestion.title} detail={suggestion.detail}
      action={<button type="button" className={ui.textButton} onClick={suggestion.accept}>切回自动</button>}
      onDismiss={suggestion.dismiss} />}
  </div>;
}
