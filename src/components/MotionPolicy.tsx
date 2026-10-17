import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { motionPreference, setMotionPreference } from "@/lib/motionPreference";

type MotionMode = "full" | "reduced" | "off" | "hidden";
const MotionModeContext = createContext<MotionMode>("full");
export const useInterfaceMotion = () => useContext(MotionModeContext);

/** One policy per WebView, including windows that stay mounted after hide(). */
export function MotionPolicy({ children }: { children: ReactNode }) {
  const enabled = useSyncExternalStore(motionPreference.subscribe, motionPreference.getSnapshot);
  const reduced = usePrefersReducedMotion();
  const visible = useWindowVisible();
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const mode: MotionMode = !visible || !documentVisible ? "hidden" : !enabled ? "off" : reduced ? "reduced" : "full";

  useLayoutEffect(() => {
    document.documentElement.dataset.interfaceMotion = mode;
    // Hidden windows pause CSS instead of removing animations; restoring focus
    // must not replay the editor's window entrance or a completed confirmation.
    document.documentElement.classList.toggle("no-anim", !enabled || reduced);
    return () => { delete document.documentElement.dataset.interfaceMotion; document.documentElement.classList.remove("no-anim"); };
  }, [mode, enabled, reduced]);

  useEffect(() => {
    const onVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>("interface-motion-changed", event => setMotionPreference(event.payload))
      .then(off => { if (disposed) off(); else unlisten = off; })
      .catch(() => { /* Browser preview keeps the local setting. */ });
    return () => { disposed = true; unlisten?.(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  return <MotionModeContext.Provider value={mode}>{children}</MotionModeContext.Provider>;
}
