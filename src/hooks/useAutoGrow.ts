/**
 * useAutoGrow — 让 `textarea` 随内容长高，到上限后内部滚（A-61 ②）。
 *
 * 两个消费点共用（规则 #11）：中栏工具栏的**提问框**与
 * 问答面板底部的**追问框**。两边都会写长，只改一边就是新的不一致。
 */
import { useEffect, useRef, type RefObject } from "react";

/** 没给容器时的固定上限行数。 */
const DEFAULT_MAX_ROWS = 4;

/**
 * 给了容器时的自适应参数。
 *
 * 🔴 为什么不是直接把 `DEFAULT_MAX_ROWS` 调大：输入框所在的 `.foot` 是
 * `flex-shrink: 0`，它长多少，上面的答案区就少多少。写死成 8 行的话，
 * 矮窗口（三栏、第三栏再上下分一刀）下输入框会把答案区吃光。
 * 所以上限必须跟容器高度挂钩，而不是一个常数。
 */
const ADAPTIVE_FRACTION = 0.4;
const ADAPTIVE_MIN_ROWS = 3;
const ADAPTIVE_MAX_ROWS = 10;

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
    /**
     * 可选：所在面板。给了就把上限改成
     * `clamp(3 行, 面板高 × 40%, 10 行)`，不给则用固定 `maxRows`。
     *
     * ❗ 面板被拖动改高时也得重算，所以内部挂了 `ResizeObserver`——
     *   只在 `value` 变时算的话，拖完分栏得再敲一下键才生效。
     */
    containerRef?: RefObject<HTMLElement | null>;
  },
) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
  const enabled = opts?.enabled ?? true;
  const containerRef = opts?.containerRef;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const apply = () => {
      // 先置 `auto` 再读 `scrollHeight`：不置的话删字时高度不会回落
      // （scrollHeight 永远 ≥ 当前高度）。
      el.style.height = "auto";
      const cs = getComputedStyle(el);
      // 行高可能是 `normal`（parseFloat 得 NaN），兜一个接近 13px/1.45 的值。
      const line = parseFloat(cs.lineHeight) || 19;
      // 上限里要把 padding 加回去：scrollHeight 含 padding，而行高×行数不含。
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const rowsCap = (rows: number) => Math.ceil(line * rows + pad);

      const container = containerRef?.current;
      const cap = container
        ? Math.min(
            rowsCap(ADAPTIVE_MAX_ROWS),
            Math.max(rowsCap(ADAPTIVE_MIN_ROWS), container.clientHeight * ADAPTIVE_FRACTION),
          )
        : rowsCap(maxRows);

      el.style.height = `${Math.min(el.scrollHeight, Math.ceil(cap))}px`;
    };

    apply();

    const container = containerRef?.current;
    if (!container) return;
    const ro = new ResizeObserver(apply);
    ro.observe(container);
    return () => ro.disconnect();
  }, [value, maxRows, enabled, containerRef]);

  return ref;
}
