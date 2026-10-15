import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import styles from "./MobileNotice.module.css";

/** Keep the last result during collapse, without keeping failed actions interactive. */
export function MobileFeedbackSlot({ children }: { children?: ReactElement | null | false }) {
  const [saved, setSaved] = useState(children);
  const root = useRef<HTMLDivElement>(null);
  const present = children || saved;
  const open = !!children;
  useLayoutEffect(() => { if (children) setSaved(children); }, [children]);
  useLayoutEffect(() => {
    const element = root.current;
    if (open) {
      if (!element || document.hidden || element.parentElement?.closest('[hidden], [inert]') || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const height = element.getBoundingClientRect().height;
      const animation = height ? element.animate?.([{ height: "0px" }, { height: `${height}px` }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }) : undefined;
      return () => animation?.cancel();
    }
    if (!element) return;
    if (document.hidden || element.parentElement?.closest('[hidden], [inert]') || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setSaved(null); return; }
    const animation = element.animate?.([{ height: `${element.getBoundingClientRect().height}px`, opacity: 1 }, { height: "0px", opacity: 0 }], {
      duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards",
    });
    const timer = setTimeout(() => { animation?.cancel(); setSaved(null); }, 200);
    return () => { clearTimeout(timer); animation?.cancel(); };
  }, [open]);
  if (!present) return null;
  return <div ref={root} className={styles.feedbackSlot} data-state={children ? "open" : "closing"} inert={!children} aria-hidden={!children || undefined}>{present}</div>;
}
