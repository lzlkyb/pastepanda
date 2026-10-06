import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { rcSessionDisplay } from "@/lib/api/rcCommands";
import { useMobileLayout } from "../ui/useMobileLayout";

type Orientation = ScreenOrientation & { lock: (value: string) => Promise<void>; unlock: () => void };

/** Android owns system bars; browser fullscreen is a fallback for the web preview. */
export function useOrientationLock(sessionId?: string) {
  const [hint, setHint] = useState("");
  const landscape = useMobileLayout();
  const native = isTauri() && /Android/i.test(navigator.userAgent);
  const orientation = useRef<"system" | "portrait" | "landscape">("system");
  const locked = useRef(false);
  const ownsFullscreen = useRef(false);
  const alive = useRef(true);
  const clearHint = useCallback(() => setHint(""), []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (native && sessionId) void rcSessionDisplay(sessionId, false, false).catch(() => {});
      if (locked.current) try { (screen.orientation as Orientation).unlock(); } catch { /* Already released. */ }
      // Fullscreen can succeed while orientation locking fails. Track ownership separately.
      if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [native, sessionId]);
  useEffect(() => {
    if (!native || !sessionId) return;
    void rcSessionDisplay(sessionId, true, landscape, orientation.current).catch(() => {
      if (alive.current) setHint("无法应用全屏显示设置，请重试切换方向。");
    });
  }, [native, sessionId, landscape]);
  const apply = useCallback(async (next: "portrait" | "landscape") => {
    setHint("");
    if (native && sessionId) {
      const previous = orientation.current;
      orientation.current = next;
      try {
        await rcSessionDisplay(sessionId, true, next === "landscape", next);
      } catch {
        if (orientation.current === next) orientation.current = previous;
        if (alive.current) setHint("无法切换显示方向，请重试。");
      }
      return;
    }
    let fullscreenBlocked = false;
    if (next === "landscape") {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          ownsFullscreen.current = true;
        }
      } catch { fullscreenBlocked = true; }
    }
    try {
      await (screen.orientation as Orientation).lock(next);
      locked.current = true;
    } catch {
      if (alive.current) setHint(fullscreenBlocked ? "浏览器未允许全屏，请打开手机自动旋转后转动手机。" : "未能锁定显示方向，请打开自动旋转后转动手机。");
    }
    if (next === "portrait" && ownsFullscreen.current && document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      ownsFullscreen.current = false;
    }
  }, [native, sessionId]);
  const enterLandscape = useCallback(() => apply("landscape"), [apply]);
  const exitLandscape = useCallback(() => apply("portrait"), [apply]);
  return { hint, clearHint, enterLandscape, exitLandscape };
}
