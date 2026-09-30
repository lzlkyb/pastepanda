/**
 * useRcOutcome — 会话里「一件事的结果」的**唯一**出口（甲-②，2026-09-29）。
 *
 * 为什么要把 toast 包一层而不是各调用点各推一次：结果来源有四处（远程改档 / 声音 /
 * 剪贴板 / 文件），而 `toast(...)` 那条通道在全屏态是**看不见**的（toast 容器挂在
 * rc-main.tsx 的树根，不在全屏元素 `.sessionWrap` 的子树里）。逐点补「再推一次出口条」
 * 就是规则 11.1 说的「第 7 个调用点照样漏」。这里把两件事绑成一次调用：
 * 说（toast，窗口态好用）+ 留（出口条，收起态与全屏态都在）。
 *
 * 返回值刻意就是 `ToastFn` 签名——现有调用点（`onStatus` / `useRcRemoteSend` /
 * `useRcSessionAudio`）原样接，不需要知道下面多了一条队列。
 * 需要「带重试按钮 / 带进度」的富条目走 `push`（同一个 store，不另造状态）。
 */
import { useCallback, useEffect } from "react";
import { useToast, type ToastFn } from "@/components/Toast";
import { pushRcOutlet, clearRcOutlet, type RcOutletEntry } from "@/stores/rcOutletStore";
import { rcOutletKindOfToast } from "@/lib/rcOutlet";

/** 出口条的入参（`kind` 之外的字段原样透传）。 */
export type RcOutletPush = Omit<RcOutletEntry, "id" | "kind"> & { kind?: RcOutletEntry["kind"] };

export interface RcOutcome {
  /** toast + 出口条，一次调用两处都到。 */
  say: ToastFn;
  /** 只进出口语（不重复说 toast）——内联反馈已经在本域里出现过时用。 */
  push: (e: RcOutletPush) => number;
}

export function useRcOutcome(sessionId: string): RcOutcome {
  const { toast } = useToast();

  // 换会话 / 卸载：上一场的残留不该飘进新画面（出口条住在常驻层，不会自己消失）
  useEffect(() => () => clearRcOutlet(), [sessionId]);

  const say = useCallback<ToastFn>(
    (message, type, duration, onRetry, actionLabel, copyText, action, onAction) => {
      toast(message, type, duration, onRetry, actionLabel, copyText, action, onAction);
      pushRcOutlet({
        kind: rcOutletKindOfToast(type),
        label: message,
        // toast 的「重试」语义原样带过来，出口条才有可点的第二现场
        actionLabel: onRetry ? (actionLabel ?? "重试") : actionLabel,
        onAction: onRetry ?? onAction,
      });
    },
    [toast],
  );

  const push = useCallback((e: RcOutletPush) => pushRcOutlet({ ...e, kind: e.kind ?? "info" }), []);

  return { say, push };
}
