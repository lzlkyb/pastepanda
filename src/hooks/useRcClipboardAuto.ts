/**
 * useRcClipboardAuto — 自动同步剪贴板，失败累计由 UI 展示。
 */
import { useEffect, useRef, useState } from "react";
import { rcPushClipboard } from "@/lib/api/rc";
import { useWindowVisible } from "@/hooks/useWindowVisible";

export function useRcClipboardAuto(opts: {
  enabled: boolean;
  canControl: boolean;
  sessionId: string;
  onFailToast: (msg: string) => void;
}) {
  const { enabled, canControl, sessionId, onFailToast } = opts;
  const visible = useWindowVisible();
  const [lastAutoAt, setLastAutoAt] = useState(0);
  const [autoFail, setAutoFail] = useState(0);
  const lastClip = useRef<string | null>(null);
  const failRef = useRef(0);

  useEffect(() => {
    if (!enabled || !canControl || !visible) return;
    const t = window.setInterval(async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text !== lastClip.current) {
          lastClip.current = text;
          await rcPushClipboard(text);
          failRef.current = 0;
          setAutoFail(0);
          setLastAutoAt(Date.now());
        }
      } catch (e) {
        failRef.current += 1;
        setAutoFail(failRef.current);
        if (failRef.current === 3) onFailToast(String(e));
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [enabled, canControl, visible, sessionId, onFailToast]);

  return {
    lastAutoAt,
    autoFail,
    resetBaseline: () => {
      lastClip.current = null;
    },
  };
}
