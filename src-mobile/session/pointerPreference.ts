import { POINTER_MODES, type PointerMode } from "./pointerModes";

const MODE_KEY = "pastepanda-mobile-pointer-mode";

/** Storage may be unavailable; the recommended mode remains usable in that case. */
export function readPointerPreference(): PointerMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved && Object.prototype.hasOwnProperty.call(POINTER_MODES, saved) ? saved as PointerMode : "trackpad";
  } catch { return "trackpad"; }
}

/** Let each visible caller report persistence failure beside its own controls. */
export function savePointerPreference(mode: PointerMode): void {
  localStorage.setItem(MODE_KEY, mode);
}
