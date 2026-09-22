/**
 * useOkAutoClear — 成功/信息浮条按 U4 撤销条口径自动消失（6s）。
 *
 * 错误（kind === "bad" / "err"）**不**自动清：它们承载「要动手」的信息，
 * 5–6 秒后蒸发等于把失败藏起来（U3.5 的 toast 版）。
 *
 * 入参刻意是 **kind 字符串 + 稳定 clear**，不是整个 fb 对象——
 * 对象字面量每次渲染都是新引用，会把 6s 计时器反复清零。
 */
import { useEffect } from "react";
import { UNDO_WINDOW_MS } from "@/components/Toast";

export function useOkAutoClear(
  kind: string | null | undefined,
  clear: () => void,
  ms: number = UNDO_WINDOW_MS,
) {
  useEffect(() => {
    if (!kind || kind === "bad" || kind === "err") return;
    const t = window.setTimeout(clear, ms);
    return () => window.clearTimeout(t);
  }, [kind, clear, ms]);
}
