/**
 * useRcImeGuard — 远程会话的输入法守卫（乙-①，2026-09-30）。
 *
 * 只做三件事，全部挂在画面盒（`.fakeScreen`，也就是键盘事件的那一个元素）上：
 * 1. 候选期间**零键外发**：`imeBlocksKey` 给 `useRcInput` 的 keydown/keyup 当前置闸；
 * 2. 候选期间在常驻出口条挂一枚琥珀「本机输入法输入中」（甲-② 的那条出口 = 收起态
 *    也还在的那一层，规则 15.1）；
 * 3. 选字完成后按模式处理：打字模式把最终字符串按 Unicode 发给对端，直传模式不发
 *    （判据全在 `lib/rcKeyMode`，这里只管事件与队列）。
 *
 * 为什么不把 composing 放进 `useState` 就完事：keydown 的判定必须**同步**读到最新值，
 * 而 React 的 state 在同一轮事件里可能还是旧的（compositionstart 与第一颗 keydown
 * 的先后顺序在不同 IME 下不一样）。所以真值放 ref，state 只用于「要不要挂 chip」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcSendInput } from "@/lib/api/rc";
import { imeIntercepted, rcImeCommitOf, type RcKeyMode } from "@/lib/rcKeyMode";
import { dismissRcOutlet, pushRcOutlet } from "@/stores/rcOutletStore";

/** 出口条那枚候选提示的合并键（同一场候选只占一条）。 */
const IME_MERGE_KEY = "ime-composing";

export function useRcImeGuard({
  canControl,
  keyMode,
}: {
  canControl: boolean;
  /** 当前键盘模式（决定选字结果发不发）。 */
  keyMode: RcKeyMode;
}) {
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const outletId = useRef<number | null>(null);
  /** 候选被 Esc 取消过——compositionend 带回来的还是拼音字母，不许当文本发。 */
  const cancelledRef = useRef(false);

  const clearChip = useCallback(() => {
    if (outletId.current != null) {
      dismissRcOutlet(outletId.current);
      outletId.current = null;
    }
  }, []);

  const mark = useCallback((on: boolean) => {
    composingRef.current = on;
    setComposing(on);
    if (on) {
      // run 档 = 常驻（不自动清），候选结束由 clearChip  explicit 撤
      outletId.current = pushRcOutlet({
        kind: "run",
        label: "本机输入法输入中",
        detail: "候选期间的按键不会发给对方",
        mergeKey: IME_MERGE_KEY,
      });
    } else clearChip();
  }, [clearChip]);

  useEffect(
    () => () => {
      // 卸载兜底：候选中途切会话/关窗，琥珀条不能留在下一场画面上
      clearChip();
    },
    [clearChip],
  );

  const onCompositionStart = useCallback(() => {
    if (!canControl) return;
    cancelledRef.current = false;
    mark(true);
  }, [canControl, mark]);

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent) => {
      if (!canControl) return;
      mark(false);
      const text = cancelledRef.current ? "" : e.data;
      cancelledRef.current = false;
      const commit = rcImeCommitOf(keyMode, text);
      if (commit) void rcSendInput({ kind: "text", text: commit }).catch(() => {});
    },
    [canControl, keyMode, mark],
  );

  /** keydown/keyup 的前置闸：候选期间（含 IME 的第一颗键）一律不外发。 */
  const imeBlocksKey = useCallback(
    (e: { isComposing?: boolean; keyCode?: number; key?: string }) =>
      imeIntercepted(e, composingRef.current),
    [],
  );

  /** 取消候选（Esc）：这一次 compositionend 的文本不发出去。 */
  const noteImeCancelled = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  return {
    composing,
    imeBlocksKey,
    imeHandlers: { onCompositionStart, onCompositionEnd },
    noteImeCancelled,
  };
}
