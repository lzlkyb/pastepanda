/**
 * useAutoGrow — 让 `textarea` 随内容长高，到上限后内部滚（A-61 ②）。
 *
 * 两个消费点共用（规则 #11）：中栏工具栏的**提问框**与
 * 问答面板底部的**追问框**。两边都会写长，只改一边就是新的不一致。
 */
import { useEffect, useRef } from "react";

/** 默认最多长到几行。超过 4 行就开始挤列表了；而四行（~120 字）远超典型问题长度。 */
const DEFAULT_MAX_ROWS = 4;

export function useAutoGrow(
  value: string,
  opts?: {
    maxRows?: number;
    /**
     * 本框当前在不在。
     *
     * ❗ 它必须进依赖：工具栏那个 textarea 只在问模式渲染，
     *   从搜切回问时它是**新挂载**的。而那一刻 `value` 可能没变
     *   （之前打的问题还在），只依赖 `value` 的 effect 不会重跑，
     *   新框就停在 CSS 给的一行高度上。
     */
    enabled?: boolean;
  },
) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
  const enabled = opts?.enabled ?? true;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    // 先置 `auto` 再读 `scrollHeight`：不置的话删字时高度不会回落
    // （scrollHeight 永远 ≥ 当前高度）。
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    // 行高可能是 `normal`（parseFloat 得 NaN），兜一个接近 13px/1.45 的值。
    const line = parseFloat(cs.lineHeight) || 19;
    // 上限里要把 padding 加回去：scrollHeight 含 padding，而行高×行数不含。
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = `${Math.min(el.scrollHeight, Math.ceil(line * maxRows + pad))}px`;
  }, [value, maxRows, enabled]);

  return ref;
}
