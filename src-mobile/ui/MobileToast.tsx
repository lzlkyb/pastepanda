import { useState } from "react";
import { useMobileNoticeTimer } from "./useMobileNoticeTimer";
import { createPortal } from "react-dom";
import { MobileNotice, type MobileNoticeProps } from "./MobileNotice";
import styles from "./MobileNotice.module.css";

/** Only ordinary outcomes expire. Pausing preserves remaining reading time. */
export function MobileToast({ onDismiss, placement = "floating", ...props }: MobileNoticeProps & {
  onDismiss: () => void;
  placement?: "floating" | "flow";
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const tone = props.tone ?? (props.error ? "error" : "info");
  useMobileNoticeTimer(tone === "info" || tone === "success", props.title ?? props.children, onDismiss, hovered || focused);
  const content = <div className={placement === "flow" ? styles.flowHost : styles.toastHost}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
    <MobileNotice {...props} tone={tone} variant={placement === "flow" ? "banner" : "toast"} onDismiss={onDismiss} />
  </div>;
  // Paging uses a transformed ancestor; floating notices must use viewport coordinates.
  return placement === "floating" ? createPortal(content, document.body) : content;
}
