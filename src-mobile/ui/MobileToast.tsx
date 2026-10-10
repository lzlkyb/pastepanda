import { useRef, useState } from "react";
import { useMobileNoticeTimer } from "./useMobileNoticeTimer";
import { createPortal } from "react-dom";
import { MobileNotice, type MobileNoticeProps } from "./MobileNotice";
import styles from "./MobileNotice.module.css";
import { useFloatingNotice } from "./useFloatingNotice";

/** Only ordinary outcomes expire. Pausing preserves remaining reading time. */
export function MobileToast({ onDismiss, placement = "floating", ...props }: MobileNoticeProps & {
  onDismiss: () => void;
  placement?: "floating" | "flow";
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const tone = props.tone ?? (props.error ? "error" : "info");
  const notice = useFloatingNotice(placement === "floating", tone, props.title ?? props.children, props.detail, onDismiss);
  useMobileNoticeTimer(tone === "info" || tone === "success", props.title ?? props.children, notice.dismiss, hovered || focused || !notice.visible, host);
  const content = <div ref={host} hidden={!notice.visible} className={placement === "flow" ? styles.flowHost : styles.toastHost}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
    <MobileNotice {...props} tone={tone} variant={placement === "flow" ? "banner" : "toast"} onDismiss={notice.dismiss} />
  </div>;
  // Paging uses a transformed ancestor; floating notices must use viewport coordinates.
  return placement === "floating" ? createPortal(content, document.body) : content;
}
