import { useEffect, useRef } from "react";
import { clampRcFloatingMousePosition } from "@/lib/utils";

export function useFloatingMouse({ enabled, surfaceRef, point, move, reveal, cancel }: {
  enabled: boolean;
  surfaceRef: React.RefObject<HTMLElement | null>;
  point: () => { clientX: number; clientY: number } | null;
  move: (dx: number, dy: number) => void;
  reveal: () => void;
  cancel: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ point, move, reveal, cancel });
  callbacks.current = { point, move, reveal, cancel };
  useEffect(() => {
    const host = surfaceRef.current, root = rootRef.current, handle = handleRef.current;
    if (!host || !root || !handle || !enabled) return;
    let active: { id: number; x: number; y: number } | null = null;
    let position = { x: 0, y: 0 };
    const place = () => {
      const rect = host.getBoundingClientRect();
      const controls = root.getBoundingClientRect();
      position = clampRcFloatingMousePosition(position.x, position.y, rect.width, rect.height, controls.width || 208, controls.height || 116);
      root.style.left = `${position.x}px`;
      root.style.top = `${position.y}px`;
    };
    const reposition = () => {
      const rect = host.getBoundingClientRect(), p = callbacks.current.point();
      position = { x: p ? p.clientX - rect.left : rect.width / 2, y: p ? p.clientY - rect.top + 65 : rect.height / 2 };
      place();
      callbacks.current.reveal();
    };
    const down = (e: PointerEvent) => {
      if (active || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      active = { id: e.pointerId, x: e.clientX, y: e.clientY };
      handle.setPointerCapture(e.pointerId);
    };
    const movePointer = (e: PointerEvent) => {
      if (!active || e.pointerId !== active.id) return;
      const dx = e.clientX - active.x, dy = e.clientY - active.y;
      active = { id: e.pointerId, x: e.clientX, y: e.clientY };
      position.x += dx;
      position.y += dy;
      // 边缘只约束本地控制柄，不能限制电脑指针的可达范围。
      place();
      callbacks.current.move(dx, dy);
    };
    const up = (e: PointerEvent) => {
      if (active?.id === e.pointerId) active = null;
    };
    const interrupted = (e?: PointerEvent) => {
      if (e && active?.id !== e.pointerId) return;
      active = null;
      callbacks.current.cancel();
    };
    const cancelActive = () => interrupted();
    const hidden = () => { if (document.hidden) cancelActive(); };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(host);
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", movePointer);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", interrupted);
    handle.addEventListener("lostpointercapture", interrupted);
    window.addEventListener("blur", cancelActive);
    window.addEventListener("orientationchange", cancelActive);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      observer.disconnect();
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", movePointer);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", interrupted);
      handle.removeEventListener("lostpointercapture", interrupted);
      window.removeEventListener("blur", cancelActive);
      window.removeEventListener("orientationchange", cancelActive);
      document.removeEventListener("visibilitychange", hidden);
      if (active) callbacks.current.cancel();
    };
  }, [enabled, surfaceRef]);
  return { rootRef, handleRef };
}
