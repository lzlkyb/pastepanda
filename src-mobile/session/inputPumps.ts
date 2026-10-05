/**
 * inputPumps — 输入发送的两只「合流泵」（从 useRcMobileInput 拆出，桌面
 * useRcInput 的 queueMove / sendWheel 同构）。
 *
 * 只做时间维度的合流，不做门控、不做坐标换算：该不该发由调用方在 emit 里
 * 判断（allowed / canControl），泵保证的是节流与合并不丢最新值（latest-wins）。
 * clear 必须在 releaseAll / 卸载时调用，否则停用后还会补发一次积压事件。
 */
import { MOVE_THROTTLE_MS, WHEEL_MERGE_MS } from "./touchConstants";

/** 指针移动节流：16ms latest-wins，窗口内后到的坐标覆盖先到的。 */
export function createMovePump(emit: (p: { x: number; y: number }) => void) {
  const at = { current: 0 };
  const pending = { current: null as { x: number; y: number } | null };
  const timer = { current: null as number | null };
  const flush = () => {
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) emit(p);
  };
  return {
    queue(x: number, y: number): void {
      pending.current = { x, y };
      const wait = MOVE_THROTTLE_MS - (Date.now() - at.current);
      if (wait <= 0) {
        at.current = Date.now();
        flush();
      } else if (timer.current == null) {
        timer.current = window.setTimeout(flush, wait);
      }
    },
    clear(): void {
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
  };
}

/** 滚轮合并：16ms 内 delta 累加、坐标取最新，一帧一个 wheel 事件。 */
export function createWheelPump(emit: (p: { x: number; y: number; delta: number }) => void) {
  const lastAt = { current: 0 };
  const pending = { current: null as { x: number; y: number; delta: number } | null };
  const timer = { current: null as number | null };
  const flush = () => {
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    lastAt.current = Date.now();
    emit(p);
  };
  return {
    push(x: number, y: number, delta: number): void {
      const prev = pending.current;
      pending.current = { x, y, delta: (prev?.delta ?? 0) + delta };
      const wait = WHEEL_MERGE_MS - (Date.now() - lastAt.current);
      if (wait <= 0) flush();
      else if (timer.current == null) timer.current = window.setTimeout(flush, wait);
    },
    clear(): void {
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
  };
}
