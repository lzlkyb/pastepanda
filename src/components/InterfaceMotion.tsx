import { useLayoutEffect, type ReactNode } from "react";
import { MotionConfig, MotionGlobalConfig } from "framer-motion";
import { CONTENT_TRANSITION } from "@/lib/motion";
import { MotionPolicy, useInterfaceMotion } from "./MotionPolicy";

function MotionRuntime({ children }: { children: ReactNode }) {
  const mode = useInterfaceMotion();
  const immediate = mode === "off" || mode === "hidden";
  useLayoutEffect(() => {
    // Explicit descendant transitions also obey the application switch.
    MotionGlobalConfig.skipAnimations = immediate;
    return () => { MotionGlobalConfig.skipAnimations = false; };
  }, [immediate]);
  return <MotionConfig reducedMotion={mode === "full" ? "never" : "always"}
    transition={immediate ? { duration: 0 } : CONTENT_TRANSITION}>{children}</MotionConfig>;
}

/** Existing Framer windows share policy without adding the runtime to capture roots. */
export function InterfaceMotion({ children }: { children: ReactNode }) {
  return <MotionPolicy><MotionRuntime>{children}</MotionRuntime></MotionPolicy>;
}
