import { useEffect, useRef, useState } from "react";
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
  const remaining = useRef(4000);
  useEffect(() => { remaining.current = 4000; }, [tone, props.title, props.children]);
  useEffect(() => {
    if (tone !== "info" && tone !== "success") return;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining.current -= Date.now() - started;
    };
    const resume = () => {
      if (document.hidden || document.body.dataset.mobileSheets || hovered || focused || timer !== undefined) return;
      started = Date.now();
      timer = setTimeout(onDismiss, Math.max(0, remaining.current));
    };
    const visibility = () => { if (document.hidden || document.body.dataset.mobileSheets) pause(); else resume(); };
    const modal = new MutationObserver(visibility);
    modal.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-sheets"] });
    resume();
    document.addEventListener("visibilitychange", visibility);
    return () => { pause(); modal.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, [tone, props.title, props.children, onDismiss, hovered, focused]);
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
