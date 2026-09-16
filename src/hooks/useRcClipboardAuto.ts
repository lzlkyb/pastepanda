/**
 * useRcClipboardAuto — 自动同步剪贴板，失败累计由 UI 展示。
 *
 * B5 隐私红线：开启开关时**不**立即外发当前剪贴板（那一刻可能是密码/验证码）。
 * 改为把「开启瞬间」的剪贴板设为基线，只有**之后发生变化**才发给对方；用户必须
 * 主动改动才触发首次发送。
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
  // 首个轮询仅用来建立基线，不发；之后变化才发。
  const baselineSet = useRef(false);

  useEffect(() => {
    if (!enabled || !canControl || !visible) return;
    baselineSet.current = false;
    const t = window.setInterval(async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!baselineSet.current) {
          // 建立基线：记录开启瞬间剪贴板，不发送
          lastClip.current = text;
          baselineSet.current = true;
          return;
        }
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

  return { lastAutoAt, autoFail };
}
