import { useCallback, useEffect, useRef, useState } from "react";
import { mapNormFromCanvas, mapNormToClient } from "@/lib/rcPointer";
import type { PinchViewportHandle } from "../video/PinchViewport";
import type { RcMobileInput } from "./useRcMobileInput";
import type { TouchCallbacks } from "./touchClassifier";
import { useTouchGestures } from "./useTouchGestures";
import { POINTER_MODES, type PointerMode } from "./pointerModes";
import { LONG_PRESS_MS } from "./touchConstants";
import { readPointerPreference, savePointerPreference } from "./pointerPreference";
import { mobileHaptic } from "../ui/nativeInteraction";

export type { PointerMode } from "./pointerModes";

/** 保存内容坐标而非屏幕像素，键盘、旋转或缩放后指针仍指向同一目标。 */
export function useSessionPointer({
  input,
  canvasRef,
  contentRef,
  surfaceRef,
  viewportRef,
  enabled,
  canControl = true,
  releaseKeys,
  feedback,
}: {
  input: RcMobileInput;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  contentRef: React.RefObject<{ w: number; h: number }>;
  surfaceRef: React.RefObject<HTMLElement | null>;
  viewportRef: React.RefObject<PinchViewportHandle | null>;
  enabled: boolean;
  canControl?: boolean;
  releaseKeys: () => void;
  feedback: {
    cursorOn(x: number, y: number): void;
    ripple(x: number, y: number, kind: "left" | "right" | "big"): void;
    charge(mode: "on" | "drag" | "off", x?: number, y?: number): void;
  };
}) {
  const [mode, setMode] = useState<PointerMode>(readPointerPreference);
  const [hint, setHint] = useState("");
  const [hintTone, setHintTone] = useState<"success" | "warning">("success");
  const clearHint = useCallback(() => setHint(""), []);
  const [mouseOpen, setMouseOpen] = useState(true);
  const padOpen = mode === "pad";
  const [dragging, setDragging] = useState(false);
  const dragOwner = useRef<"button" | "gesture" | null>(null);
  const [scrolling, setScrolling] = useState(false);
  const [charging, setCharging] = useState(false);
  const clickEnabled = enabled && canControl && !dragging && !scrolling;
  const padRef = useRef<HTMLDivElement>(null);
  const position = useRef({ x: 32768, y: 32768 });
  const initialized = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const options = useRef({ input, enabled, releaseKeys, dragging, scrolling, mode, feedback });
  options.current = { input, enabled, releaseKeys, dragging, scrolling, mode, feedback };
  const point = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return mapNormToClient(position.current.x, position.current.y, canvas, contentRef.current.w, contentRef.current.h);
  }, [canvasRef, contentRef]);
  const cancel = useCallback(() => {
    dragOwner.current = null;
    options.current.input.releaseAll();
    options.current.releaseKeys();
    setDragging(false);
    setScrolling(false);
    setCharging(false);
    options.current.feedback.charge("off");
  }, []);
  const locate = (x: number, y: number, relative: boolean) => {
    const canvas = canvasRef.current;
    const p = point();
    if (!canvas || !p) return null;
    initialized.current = true;
    const dx = x - last.current.x,
      dy = y - last.current.y;
    last.current = { x, y };
    if (options.current.scrolling) {
      input.scrollByFrame(dx, dy, p.clientX, p.clientY);
      return null;
    }
    position.current = mapNormFromCanvas(
      { clientX: relative ? p.clientX + dx : x, clientY: relative ? p.clientY + dy : y },
      canvas,
      contentRef.current.w,
      contentRef.current.h,
    );
    const next = point();
    if (!next) return null;
    viewportRef.current?.reveal(next.clientX, next.clientY);
    const visible = point()!;
    feedback.cursorOn(visible.clientX, visible.clientY);
    if (options.current.dragging) feedback.charge("drag", visible.clientX, visible.clientY);
    return visible;
  };
  const click = (button: 1 | 2, isDouble = false) => {
    if (!clickEnabled) return;
    initialized.current = true;
    const p = point();
    if (!p) return;
    input.sendClick(button, p.clientX, p.clientY);
    feedback.ripple(p.clientX, p.clientY, button === 2 ? "right" : isDouble ? "big" : "left");
  };
  const callbacks = (pad: boolean): TouchCallbacks => {
    const relative = pad || mode === "trackpad";
    // 独立操作区承担输入时，画面只导航本地视野；滚动按钮显式开启后才发滚轮。
    const localView = !pad && (mode === "pad" || mode === "floating") && !scrolling;
    const move = (x: number, y: number) => {
      if (localView) {
        viewportRef.current?.applyPinch(1, x - last.current.x, y - last.current.y, x, y);
        last.current = { x, y };
        const p = point();
        if (p) feedback.cursorOn(p.clientX, p.clientY);
        return;
      }
      if (!canControl) return;
      const p = locate(x, y, relative);
      if (p) input.queueMove(p.clientX, p.clientY);
    };
    return {
      onTap: (x, y, isDouble) => {
        if (localView) return;
        if (!relative) locate(x, y, false);
        if (!scrolling) click(1, isDouble);
      },
      onMoveTo: move,
      onCharge: (x, y) => {
        if (localView || !canControl || dragging || scrolling) return;
        const p = relative ? point() : locate(x, y, false);
        if (p) { feedback.charge("on", p.clientX, p.clientY); setCharging(true); }
      },
      onChargeCancel: () => { feedback.charge("off"); setCharging(false); },
      onRightClick: (x, y) => {
        if (localView) return;
        feedback.charge("off");
        setCharging(false);
        if (!relative) locate(x, y, false);
        click(2);
        if (canControl) mobileHaptic("ready");
      },
      onDragStart: (x, y) => {
        if (localView || !canControl || dragOwner.current || scrolling) return;
        const p = locate(x, y, relative);
        if (p) {
          dragOwner.current = "gesture";
          input.dragDown(p.clientX, p.clientY);
          setDragging(true);
          setCharging(false);
          feedback.charge("drag", p.clientX, p.clientY);
          mobileHaptic("ready");
        }
      },
      onDragMove: move,
      onDragEnd: () => {
        // 长按判定器也会结束一次移动；只能释放由这次手势按下的键。
        if (localView || dragOwner.current !== "gesture") return;
        dragOwner.current = null;
        input.releaseAll();
        setDragging(false);
        feedback.charge("off");
      },
      onScrollDelta: (dx, dy) => {
        if (localView) {
          viewportRef.current?.applyPinch(1, dx, dy, last.current.x, last.current.y);
          const p = point();
          if (p) feedback.cursorOn(p.clientX, p.clientY);
          return;
        }
        if (!canControl || dragging) return;
        const p = point();
        if (p) input.scrollByFrame(dx, dy, p.clientX, p.clientY);
      },
      onPinchStart: cancel,
      onPinchUpdate: (ratio, dx, dy, x, y) => {
        if (!pad) {
          viewportRef.current?.applyPinch(ratio, dx, dy, x, y);
          const p = point();
          if (p) feedback.cursorOn(p.clientX, p.clientY);
        }
      },
    };
  };
  // 按下即基准：浮动鼠标与本地视野导航的相对位移以此为起点（不消费事件）。
  const onDown = (x: number, y: number) => {
    last.current = { x, y };
  };
  const surface = useTouchGestures({
    surfaceRef,
    enabled,
    onDown,
    callbacks: callbacks(false),
    onCancel: cancel,
    tapMaxMs: LONG_PRESS_MS,
  });
  const pad = useTouchGestures({
    surfaceRef: padRef,
    enabled: enabled && padOpen,
    onDown,
    callbacks: callbacks(true),
    onCancel: cancel,
    tapMaxMs: LONG_PRESS_MS,
  });
  const reset = useCallback(() => {
    cancel();
    surface.cancelAll();
    pad.cancelAll();
  }, [cancel, surface.cancelAll, pad.cancelAll]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) reset();
    };
    window.addEventListener("blur", reset);
    window.addEventListener("orientationchange", reset);
    window.addEventListener("mobile-interaction-cancel", reset);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("orientationchange", reset);
      window.removeEventListener("mobile-interaction-cancel", reset);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [reset]);
  useEffect(() => {
    if (!enabled || !canControl) reset();
  }, [enabled, canControl, reset]);
  return {
    mode,
    hint,
    hintTone,
    clearHint,
    modeHint: POINTER_MODES[mode].hint,
    mouseOpen: mouseOpen || mode === "pad" || mode === "floating",
    padOpen,
    dragging,
    scrolling,
    charging,
    clickEnabled,
    padRef,
    point,
    moveFloating: (dx: number, dy: number) => {
      if (!enabled || !canControl || mode !== "floating") return;
      const p = locate(last.current.x + dx, last.current.y + dy, true);
      if (p) input.queueMove(p.clientX, p.clientY);
    },
    reset,
    syncPosition: (x: number, y: number) => {
      if (!initialized.current) position.current = { x, y };
    },
    pickMode: (next: PointerMode) => {
      reset();
      setMode(next);
      if (next !== mode) mobileHaptic("confirm");
      try {
        savePointerPreference(next);
        setHintTone("success");
        setHint(`${POINTER_MODES[next].hint} · 已记住选择`);
      } catch {
        setHintTone("warning");
        setHint(`已切换为${POINTER_MODES[next].label}，无法保存偏好；本次会话仍可使用。`);
      }
    },
    toggleMouse: () => {
      reset();
      setMouseOpen(!mouseOpen);
    },
    click,
    toggleDrag: () => {
      reset();
      if (!enabled || !canControl || dragging) return;
      const p = point();
      if (p) {
        dragOwner.current = "button";
        input.dragDown(p.clientX, p.clientY);
        setDragging(true);
      }
    },
    toggleScroll: () => {
      reset();
      if (enabled && canControl) setScrolling(!scrolling);
    },
    reveal: () => {
      const p = point();
      if (p) {
        viewportRef.current?.reveal(p.clientX, p.clientY);
        const next = point()!;
        feedback.cursorOn(next.clientX, next.clientY);
      }
    },
  };
}
