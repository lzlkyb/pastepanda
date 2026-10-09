import { useEffect, useState } from "react";
import { SessionFeedback } from "./SessionFeedback";
import { SessionFrameState } from "./SessionScreenNotices";
import { SessionConnectionNotices } from "./SessionConnectionNotices";
import type { DirectSwitchToast } from "./useDirectSwitchToast";
import type { AutoSuggestToast } from "./useAutoSuggestToast";
import type { useSessionPointer } from "./useSessionPointer";
import type { useOrientationLock } from "./useOrientationLock";
import type { useSessionClipboard } from "./useSessionClipboard";
import type { useSessionSettings } from "./useSessionSettings";
import styles from "./RcMobileSession.module.css";

/** Acknowledgement belongs to the session, so rotating between tool layouts preserves it. */
export function useAcknowledgedSendFailure(sendFailed: boolean) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { if (!sendFailed) setAcknowledged(false); }, [sendFailed]);
  return { visible: sendFailed && !acknowledged, dismiss: () => setAcknowledged(true) };
}

/** Keep stream and command outcomes beside the session tools, outside remote targets. */
export function SessionStatusFeedback({ pointer, orient, clipboard, settings, sendFailed, onSendFailDismiss, blocked,
  statusText, waitHint, hasFrame, keyboardOpen, toggleTyping, onScreen, onMore, onReturn, onOpenChange,
  directToast, autoSuggest, feedbackOpen,
}: {
  pointer: ReturnType<typeof useSessionPointer>;
  orient: ReturnType<typeof useOrientationLock>;
  clipboard: ReturnType<typeof useSessionClipboard>;
  settings: ReturnType<typeof useSessionSettings>;
  sendFailed: boolean;
  onSendFailDismiss: () => void;
  blocked: boolean;
  landscape: boolean;
  statusText?: string;
  waitHint?: string;
  hasFrame: boolean;
  keyboardOpen: boolean;
  toggleTyping: () => void;
  onScreen: () => void;
  onMore: () => void;
  onReturn: () => void;
  onOpenChange: (open: boolean) => void;
  directToast: DirectSwitchToast | null;
  autoSuggest: AutoSuggestToast | null;
  feedbackOpen: boolean;
}) {
  return <div className={styles.feedbackSlot}>
    {hasFrame && !blocked && <SessionFrameState text={statusText} hasFrame hint={waitHint} onReturn={onReturn} />}
    <SessionFeedback pointer={pointer} orient={orient} clipboard={clipboard}
      blocked={blocked} onOpenChange={onOpenChange}
      settings={settings.notices} onSettingDismiss={settings.dismiss}
      onSettingOpen={(key) => {
        if (key === "key_mode") { if (!keyboardOpen) toggleTyping(); return; }
        if (keyboardOpen) toggleTyping();
        if (key === "audio") onMore();
        else onScreen();
      }}
      sendFailed={sendFailed} onSendFailDismiss={onSendFailDismiss} />
    <SessionConnectionNotices direct={directToast} suggestion={autoSuggest} blocked={blocked || feedbackOpen} />
  </div>;
}
