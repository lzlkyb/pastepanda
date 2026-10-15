import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mobileFeedbackIdentity, mobileFeedbackReadingTime } from "@/lib/utils";
import { useMobileNoticeTimer } from "./useMobileNoticeTimer";
import { MobileNotice, type MobileNoticeProps } from "./MobileNotice";
import { useMobileToastQueue } from "./MobileToastQueue";
import { useMobileFeedbackScope } from "./MobileFeedbackScope";
import { createMobileSpring } from "./mobileSpring";
import styles from "./MobileNotice.module.css";

type ToastProps = MobileNoticeProps & { onDismiss: () => void; placement?: "floating" | "flow" };

function ToastContent({ onDismiss, placement = "floating", ...props }: ToastProps) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [closing, setClosing] = useState(false);
  const host = useRef<HTMLDivElement>(null), motion = useRef<HTMLDivElement>(null);
  const latestDismiss = useRef(onDismiss), exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latestDismiss.current = onDismiss;
  const tone = props.tone ?? (props.error ? "error" : "info");
  const identity = mobileFeedbackIdentity(tone, props.title ?? props.children, props.detail) ?? props.title ?? props.children;
  const close = useCallback(() => {
    if (exitTimer.current !== undefined) return;
    if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { latestDismiss.current(); return; }
    setClosing(true);
    exitTimer.current = setTimeout(() => latestDismiss.current(), 200);
  }, []);
  useEffect(() => { setClosing(false); clearTimeout(exitTimer.current); exitTimer.current = undefined; }, [identity]);
  useEffect(() => () => clearTimeout(exitTimer.current), []);
  useLayoutEffect(() => {
    if (placement !== "floating" || !motion.current) return;
    const element = motion.current;
    const spring = createMobileSpring(12, value => element.style.setProperty("--mobile-feedback-offset", `${value}px`));
    spring.move(0);
    return () => spring.dispose();
  }, [placement]);
  useMobileNoticeTimer(!closing && (tone === "info" || tone === "success"), identity, close, hovered || focused, host,
    mobileFeedbackReadingTime(!!props.action, !!props.detail));
  return <div ref={host} className={placement === "flow" ? styles.flowHost : styles.toastHost} data-mobile-toast={placement}
    data-state={closing ? "closing" : "open"} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
    <div ref={motion} className={styles.toastMotion} inert={closing}>
      <MobileNotice {...props} tone={tone} variant={placement === "flow" ? "banner" : "toast"} onDismiss={close} />
    </div>
  </div>;
}

/** Floating ordinary outcomes share one queue; persistent issues stay by their controls. */
export function MobileToast(props: ToastProps) {
  const queue = useMobileToastQueue(), scope = useMobileFeedbackScope(), id = useId();
  const owner = useRef<HTMLSpanElement>(null), latest = useRef(props);
  latest.current = props;
  const tone = props.tone ?? (props.error ? "error" : "info");
  const ordinary = tone === "info" || tone === "success";
  const placement = props.placement ?? (scope ? "flow" : "floating");
  const messageIdentity = mobileFeedbackIdentity(tone, props.title ?? props.children, props.detail) ?? id;
  // Equal wording does not prove two recovery buttons act on the same resource.
  const identity = props.action ? `${messageIdentity}:${id}` : messageIdentity;
  const queued = ordinary && placement === "floating" && !!queue;
  useEffect(() => {
    if (!queued || !queue) return;
    let registered = false;
    const update = () => {
      // The marker itself is hidden; only ancestor visibility controls registration.
      const visible = !owner.current?.parentElement?.closest("[hidden], [inert]");
      if (visible === registered) return;
      registered = visible;
      if (visible) queue.enqueue({ id, identity, dismiss: () => latest.current.onDismiss(),
        render: () => <ToastContent {...latest.current} placement="floating" onDismiss={() => queue.finish(id)} /> });
      else queue.remove(id);
    };
    const visibility = new MutationObserver(update);
    for (let parent = owner.current?.parentElement; parent; parent = parent.parentElement)
      visibility.observe(parent, { attributes: true, attributeFilter: ["hidden", "inert"] });
    update();
    return () => { visibility.disconnect(); if (registered) queue.remove(id); };
  }, [queued, queue, id, identity]);
  if (!ordinary) return <MobileNotice {...props} tone={tone} />;
  if (queued) return <span ref={owner} hidden />;
  const content = <ToastContent {...props} placement={placement} />;
  return placement === "floating" ? createPortal(content, document.body) : content;
}
