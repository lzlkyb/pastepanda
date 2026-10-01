/**
 * useTouchGestures — 把 DOM Pointer 事件喂给 TouchClassifier 的绑定层。
 *
 * 职责边界（design §2）：本 hook 只做「事件 → 判定 → 回调」的搬运，
 * 不做归一化、不发任何远端事件——那些在 RcMobileSession 的回调里经
 * `useRcMobileInput` 完成。热区拦截（横屏唤出）以 `interceptDown` 注入：
 * 返回 true 的 down 被本地吃掉，绝不进手势状态机（design §5.5 红线：
 * 输入分发顺序 = 热区判定 → 手势状态机 → 远端）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { TouchClassifier, realClock, type TouchCallbacks } from "./touchClassifier";

export function useTouchGestures({
  surfaceRef,
  enabled,
  interceptDown,
  callbacks,
}: {
  /** 手势附着面：未 transform 的容器（画布在其内部被 PinchViewport 缩放）。 */
  surfaceRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  /** down 拦截：返回 true = 本地消费（热区唤出），该触点不进手势机。 */
  interceptDown?: (clientX: number, clientY: number) => boolean;
  callbacks: TouchCallbacks;
}) {
  // 回调用 ref 承接：判定期内恒取最新，避免每次渲染重绑监听器
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const interceptRef = useRef(interceptDown);
  interceptRef.current = interceptDown;

  const classifier = useMemo(
    () =>
      new TouchClassifier(
        {
          onTap: (x, y, d) => cbRef.current.onTap(x, y, d),
          onMoveTo: (x, y) => cbRef.current.onMoveTo(x, y),
          onCharge: (x, y) => cbRef.current.onCharge(x, y),
          onChargeCancel: () => cbRef.current.onChargeCancel(),
          onRightClick: (x, y) => cbRef.current.onRightClick(x, y),
          onDragStart: (x, y) => cbRef.current.onDragStart(x, y),
          onDragMove: (x, y) => cbRef.current.onDragMove(x, y),
          onDragEnd: (x, y) => cbRef.current.onDragEnd(x, y),
          onScrollDelta: (dx, dy, mx, my) => cbRef.current.onScrollDelta(dx, dy, mx, my),
          onPinchStart: (mx, my) => cbRef.current.onPinchStart(mx, my),
          onPinchUpdate: (r, dx, dy, mx, my) => cbRef.current.onPinchUpdate(r, dx, dy, mx, my),
        },
        realClock,
      ),
    [],
  );

  const cancelAll = useCallback(() => classifier.cancelAll(), [classifier]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !enabled) return;
    let suppressed = new Set<number>(); // 被热区吃掉的 pointerId（后续 move/up 不喂状态机）

    const onDown = (e: PointerEvent) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败只丢「画外抬起」兜底，不断手势（真实指针不会走到这） */
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (interceptRef.current?.(e.clientX, e.clientY)) {
        suppressed.add(e.pointerId);
        return;
      }
      classifier.down(e.pointerId, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      if (suppressed.has(e.pointerId)) return;
      classifier.move(e.pointerId, e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (suppressed.delete(e.pointerId)) return;
      classifier.up(e.pointerId, e.clientX, e.clientY);
    };
    const onCancel = (e: PointerEvent) => {
      suppressed.delete(e.pointerId);
      // 单点取消 = 该指终止；多点/系统手势直接全量复位（上层随后 releaseAll 补发 up）
      classifier.cancelAll();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      suppressed = new Set();
      classifier.cancelAll();
    };
  }, [surfaceRef, enabled, classifier]);

  return { cancelAll };
}
