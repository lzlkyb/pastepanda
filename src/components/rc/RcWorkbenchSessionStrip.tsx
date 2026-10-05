import { useRef, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import type { ToastFn } from "@/components/Toast";
import { runRcAction } from "@/lib/rcFeedback";
import { rcCanControl } from "@/lib/rcCapability";
import styles from "./RcWorkbenchSessionStrip.module.css";

/** 工具页也保留会话的停止入口；没有新增定时器或会话订阅。 */
export function RcWorkbenchSessionStrip({ peerName, pending, capability, busy, onEnd, onReturn, toast }: {
  peerName: string;
  pending: boolean;
  capability: string;
  busy: boolean;
  onEnd: () => Promise<boolean>;
  onReturn: () => void;
  toast: ToastFn;
}) {
  const [ending, setEnding] = useState(false);
  const inFlight = useRef(false);
  const stop = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setEnding(true);
    try {
      await runRcAction(onEnd, {
        ok: pending ? "已取消远程申请" : "已结束远程会话",
        fail: pending ? "取消申请失败，请重试" : "结束会话失败，请重试",
      }, toast);
    } catch {
      toast(pending ? "取消申请失败，请重试" : "结束会话失败，请重试", "error");
    } finally {
      inFlight.current = false;
      setEnding(false);
    }
  };
  return <section className={styles.strip} aria-label="当前远程会话">
    {pending ? <Clock3 size={18} aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
    <div className={styles.info} role="status">
      <strong>{pending ? `等待 ${peerName} 同意接入` : `${peerName} 正在远程${rcCanControl(capability) ? "控制" : "查看"}本机`}</strong>
      <p>{pending ? "切换工具页不会取消申请，同意后自动进入远程画面。" : "切换工具页不会结束会话，你可以随时停止共享。"}</p>
    </div>
    <div className={styles.actions}>
      <button type="button" onClick={onReturn}>返回会话</button>
      <button type="button" disabled={busy || ending} aria-busy={ending} onClick={() => void stop()}>
        {ending ? "处理中…" : pending ? "取消申请" : "结束会话"}
      </button>
    </div>
  </section>;
}
