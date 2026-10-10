import { useCallback, useEffect, useRef, useState } from "react";
import { useMobileLayout } from "../ui/useMobileLayout";

export const CAPSULE_TEACH_SECONDS = 5;
export const CAPSULE_TEACH_STORAGE_KEY = "pastepanda.session-tools-taught.v2";
export type CapsulePhase = "idle" | "teaching" | "hint" | "done";

/** Teach once per UI version. The visible tools handle remains available in every session. */
export function useImmersiveCapsule({ keyboardOpen, attention = false }: { keyboardOpen: boolean; attention?: boolean }) {
  const landscape = useMobileLayout();
  const [immersive, setImmersive] = useState(false);
  const [capsuleVisible, setCapsuleVisible] = useState(false);
  const [phase, setPhase] = useState<CapsulePhase>("idle");
  const phaseRef = useRef(phase);
  const entered = useRef(false);
  const transition = useCallback((next: CapsulePhase) => { phaseRef.current = next; setPhase(next); }, []);
  useEffect(() => {
    if (!landscape) {
      setCapsuleVisible(false); setImmersive(false);
      if (entered.current) transition("done");
      return;
    }
    if (entered.current) return;
    entered.current = true;
    let seen = false;
    try {
      seen = localStorage.getItem(CAPSULE_TEACH_STORAGE_KEY) === "1";
      localStorage.setItem(CAPSULE_TEACH_STORAGE_KEY, "1");
    } catch { /* Storage denied: keep this session's one-time guidance. */ }
    setCapsuleVisible(!seen);
    transition(seen ? "done" : "teaching");
  }, [landscape, transition]);
  const endTeaching = useCallback(() => {
    setCapsuleVisible(false);
    if (phaseRef.current === "teaching") transition("hint");
  }, [transition]);
  useEffect(() => {
    if (!landscape || (phase !== "teaching" && phase !== "hint")) return;
    const timer = setTimeout(phase === "teaching" ? endTeaching : () => transition("done"), phase === "teaching" ? CAPSULE_TEACH_SECONDS * 1000 : 4000);
    return () => clearTimeout(timer);
  }, [landscape, phase, endTeaching, transition]);
  const toggle = useCallback(() => {
    transition("done");
    setCapsuleVisible(value => !value);
  }, [transition]);
  const enterImmersive = useCallback(() => {
    transition("done"); setCapsuleVisible(false); setImmersive(true);
  }, [transition]);
  const reveal = useCallback(() => {
    transition("done"); setImmersive(false); setCapsuleVisible(true);
  }, [transition]);
  const dismissHint = useCallback(() => { if (phaseRef.current === "hint") transition("done"); }, [transition]);
  return { landscape, immersive: landscape && immersive && !keyboardOpen && !attention, enterImmersive, reveal, capsuleVisible: keyboardOpen || capsuleVisible, phase, secondsLeft: CAPSULE_TEACH_SECONDS, toggle, endTeaching, dismissHint };
}
