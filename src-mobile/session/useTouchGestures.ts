/**
 * useTouchGestures — 把 DOM Pointer 事件喂给 TouchClassifier 的绑定层。
 *
 * 职责边界（design §2）：本 hook 只做「事件 → 判定 → 回调」的搬运，
 * 不做归一化、不发任何远端事件——那些在 RcMobileSession 的回调里经
 * `useRcMobileInput` 完成。`onDown` 只用来在按下瞬间记录基准位置
 * （浮动鼠标/视野导航的相对位移起点），不做任何拦截：所有触点一律进
 * 手势状态机（横屏热区拦截已随 R2 显式把手退役）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { TouchClassifier, realClock, type TouchCallbacks } from "./touchClassifier";

export function useTouchGestures({
  surfaceRef,
  enabled,
  onDown,
  callbacks,
  onCancel,
  tapMaxMs,
  longPress = true,
}: {
  /** 手势附着面：未 transform 的容器（画布在其内部被 PinchViewport 缩放）。 */
  surfaceRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  /** down 基准：按下瞬间记录位置（相对位移的起点），不消费事件。 */
  onDown?: (clientX: number, clientY: number) => void;
  callbacks: TouchCallbacks;
  onCancel?: () => void;
  tapMaxMs?: number;
  longPress?: boolean;
}) {
  // 回调用 ref 承接：判定期内恒取最新，避免每次渲染重绑监听器
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const downRef = useRef(onDown);
  downRef.current = onDown;

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
        tapMaxMs,
        longPress,
      ),
    [tapMaxMs, longPress],
  );

  const cancelAll = useCallback(() => classifier.cancelAll(), [classifier]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !enabled) return;
    const active = new Set<number>();

    const onDown = (e: PointerEvent) => {
      if (document.body.dataset.mobileBack) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      active.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败只丢「画外抬起」兜底，不断手势（真实指针不会走到这） */
      }
      downRef.current?.(e.clientX, e.clientY);
      classifier.down(e.pointerId, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      classifier.move(e.pointerId, e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      active.delete(e.pointerId);
      classifier.up(e.pointerId, e.clientX, e.clientY);
    };
    const onCancel = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return; // Capture is also lost normally after pointerup.
      active.clear();
      // 单点取消 = 该指终止；多点/系统手势直接全量复位（上层随后 releaseAll 补发 up）
      classifier.cancelAll();
      cancelRef.current?.();
    };
    const systemCancel = () => { active.clear(); classifier.cancelAll(); };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("mobile-interaction-cancel", systemCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("mobile-interaction-cancel", systemCancel);
      active.clear();
      classifier.cancelAll();
    };
  }, [surfaceRef, enabled, classifier]);

  return { cancelAll };
}
