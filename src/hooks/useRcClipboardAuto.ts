/**
 * useRcClipboardAuto — 自动同步剪贴板，失败累计由 UI 展示。
 *
 * B5 隐私红线：开启开关时**不**立即外发当前剪贴板（那一刻可能是密码/验证码）。
 * 改为把「开启瞬间」的剪贴板设为基线，只有**之后发生变化**才发给对方；用户必须
 * 主动改动才触发首次发送。
 *
 * 2026-09-23 审计修两处：
 * ① 窗口 visible 但**没焦点**时，系统会直接拒读剪贴板抛 NotAllowedError——
 *    这不是「权限坏了」。以前照样计失败，3 轮后 RcClipboardBar 误报
 *    「检查剪贴板权限」。现在未聚焦的拒读静默跳过，不计失败。
 * ② 剪贴板被**清空**（读到空串）时以前不更新基线，导致「清空后再复制同样的
 *    内容」被当成没变化、永远不再推送。现在空串也更新基线（但空串本身不外发，
 *    与手动推送「剪贴板是空的」不发送同口径）。
 */
import { useEffect, useRef, useState } from "react";
import { rcPushClipboard } from "@/lib/api/rc";
import { useWindowVisible } from "@/hooks/useWindowVisible";

/**
 * 本轮失败是不是「只是窗口没焦点」——纯判断，守卫单测钉住（规则 11.1）。
 *
 * 判据两个都要满足：错误是 NotAllowedError（系统拒绝读取）**且**窗口当前没有
 * 焦点。真·权限被拒时窗口是聚焦的，照常计入失败让 UI 报警。
 */
export function isUnfocusedClipboardDeny(e: unknown, hasFocus: boolean): boolean {
  const name = (e as { name?: string } | null | undefined)?.name;
  return !hasFocus && name === "NotAllowedError";
}

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
        if (text === lastClip.current) return;
        // 基线跟着**任何**变化更新——包括清空（空串），否则「清空后复制回
        // 同样的内容」会因 text === lastClip 被漏推（审计修 ②）。
        lastClip.current = text;
        if (!text) return; // 清空不外发：对方侧没有可写的东西
        await rcPushClipboard(text);
        failRef.current = 0;
        setAutoFail(0);
        setLastAutoAt(Date.now());
      } catch (e) {
        // 窗口可见但失焦时的拒读 = 正常现象，静默跳过本轮（审计修 ①）。
        if (isUnfocusedClipboardDeny(e, document.hasFocus())) return;
        failRef.current += 1;
        setAutoFail(failRef.current);
        if (failRef.current === 3) onFailToast(String(e));
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [enabled, canControl, visible, sessionId, onFailToast]);

  return { lastAutoAt, autoFail };
}
