import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createSceneMotion } from "./mobileSceneMotion";
import styles from "./MobileScene.module.css";

/** Keep destination instances mounted while immediately disabling the departing scene. */
export function MobileScene({ active, className = "", label, children }: { active: boolean; className?: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const motion = createSceneMotion(ref.current);
    motion.enter("tab");
    return () => motion.dispose();
  }, [active]);
  return <section ref={ref} hidden={!active} inert={!active} aria-hidden={!active} aria-label={label} className={`${styles.scene} ${className}`}>{children}</section>;
}

export function useTaskScene(ref: React.RefObject<HTMLElement | null>, task: string, active: boolean) {
  const previous = useRef(task);
  useLayoutEffect(() => {
    const before = previous.current; previous.current = task;
    if (!active || !ref.current || task === before) return;
    const motion = createSceneMotion(ref.current);
    motion.enter(task === "list" ? "back" : "forward");
    return () => motion.dispose();
  }, [ref, task, active]);
}
