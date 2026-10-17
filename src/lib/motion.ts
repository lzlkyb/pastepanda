import type { Transition } from "framer-motion";

/** B: one cadence for controls, content and layers; CSS mirrors these in theme.css. */
export const MOTION = {
  fast: 0.15,
  base: 0.2,
  panel: 0.3,
  large: 0.4,
  ease: [0.2, 0, 0, 1],
  enter: [0.05, 0.7, 0.1, 1],
} as const;

export const CONTROL_TRANSITION: Transition = { type: "tween", duration: MOTION.fast, ease: MOTION.ease };
export const CONTENT_TRANSITION: Transition = { type: "tween", duration: MOTION.base, ease: MOTION.ease };
export const PANEL_TRANSITION: Transition = { type: "tween", duration: MOTION.panel, ease: MOTION.enter };
