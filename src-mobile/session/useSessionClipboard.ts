/**
 * useSessionClipboard — 会话内剪贴板推/取（手机端）。
 *
 * 与桌面 `RcClipboardBar` 同一条命令通道（`rcPushClipboard` / `rcPullClipboard`
 * ——后端按当前活动会话路由），不另走输入事件。反馈不放浮条：吐一个 `hint`
 * 给工具条渲染（规则 15.1：触发与反馈同一可见性域），几秒自清。
 *
 * 手机侧各多一步系统剪贴板读写（`navigator.clipboard`）：读要用户手势
 * （按钮点击满足）、写一般直接放行；被系统拒绝时给人话，不静默。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcPullClipboard, rcPushClipboard } from "@/lib/api/rc";

export function useSessionClipboard() {
  const [hint, setHintState] = useState("");
  const [clipOpen, setClipOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const setHint = useCallback((msg: string) => {
    setHintState(msg);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHintState(""), 4000);
  }, []);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const toggleClip = useCallback(() => setClipOpen((v) => !v), []);

  /** 手机 → 电脑：读本机剪贴板推过去。空剪贴板不是失败（重试也还是空）。 */
  const push = useCallback(async () => {
    setClipOpen(false);
    try {
      const t = await navigator.clipboard.readText();
      if (!t) {
        setHint("手机剪贴板是空的");
        return;
      }
      await rcPushClipboard(t);
      setHint(`已推送到电脑 · ${t.length} 字符`);
    } catch (e) {
      setHint(`推送失败：${String(e)}`);
    }
  }, [setHint]);

  /** 电脑 → 手机：拉对方剪贴板写进本机。空剪贴板同理不是失败。 */
  const pull = useCallback(async () => {
    setClipOpen(false);
    try {
      const t = await rcPullClipboard();
      if (t == null) {
        setHint("取回失败");
        return;
      }
      if (t === "") {
        setHint("电脑剪贴板是空的");
        return;
      }
      await navigator.clipboard.writeText(t);
      setHint(`已复制到手机 · ${t.length} 字符`);
    } catch (e) {
      setHint(`取回失败：${String(e)}`);
    }
  }, [setHint]);

  return { hint, clipOpen, toggleClip, push, pull };
}
