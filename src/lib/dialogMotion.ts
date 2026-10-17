/** B: short layer transitions; the backdrop never animates a blur. */
import type { TargetAndTransition, Transition } from "framer-motion";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import { CONTROL_TRANSITION, PANEL_TRANSITION, CONTENT_TRANSITION } from "@/lib/motion";

export interface DialogMotionProps {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

export interface DialogAnim {
  backdrop: DialogMotionProps;
  panel: DialogMotionProps;
}

const ENABLED: DialogAnim = {
  backdrop: {
    initial: { opacity: 0 }, animate: { opacity: 1 },
    exit: { opacity: 0, transition: CONTROL_TRANSITION },
    transition: CONTROL_TRANSITION,
  },
  panel: {
    initial: { opacity: 0, y: 12, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 8, scale: 0.99, transition: CONTENT_TRANSITION },
    transition: PANEL_TRANSITION,
  },
};
const REDUCED: DialogAnim = {
  backdrop: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: CONTROL_TRANSITION },
  panel: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: CONTROL_TRANSITION },
};
const DISABLED: DialogAnim = {
  backdrop: { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } },
  panel: { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } },
};
export function useDialogAnim(): DialogAnim {
  const mode = useInterfaceMotion();
  return mode === "full" ? ENABLED : mode === "reduced" ? REDUCED : DISABLED;
}
