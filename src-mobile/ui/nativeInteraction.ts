import { invoke, isTauri } from "@tauri-apps/api/core";

export type NativeBackEvent = { phase: "start" | "progress" | "cancel" | "commit"; progress: number; edge: "left" | "right" };
let configured: boolean | undefined;
let queue = Promise.resolve();
const android = () => isTauri() && /Android/i.test(navigator.userAgent);

/** Serialize configuration so a late enable cannot consume root-level system Back. */
export function configureNativeBack(enabled: boolean) {
  if (!android() || configured === enabled) return;
  configured = enabled;
  queue = queue.then(() => invoke("mobile_interaction_set", { enabled })).then(() => undefined).catch(() => {
    configured = undefined; // Older installations retain the normal history-based fallback.
  });
}

export function mobileHaptic(kind: "ready" | "confirm" | "reject") {
  if (android() && !document.hidden) void invoke("mobile_interaction_haptic", { kind }).catch(() => undefined);
}

export function listenNativeBack(callback: (event: NativeBackEvent) => void) {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<NativeBackEvent>).detail;
    if (!detail || !["start", "progress", "cancel", "commit"].includes(detail.phase)) return;
    callback({ ...detail, progress: Math.max(0, Math.min(1, Number(detail.progress) || 0)), edge: detail.edge === "right" ? "right" : "left" });
  };
  window.addEventListener("mobile-native-back", handler);
  return () => window.removeEventListener("mobile-native-back", handler);
}
