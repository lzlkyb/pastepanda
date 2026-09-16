/**
 * useRcInput — 鼠标节流、指针锁定相对位移、两级 Esc、键盘捕获。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcSendInput } from "@/lib/api/rc";
import { isSessionEscape } from "@/lib/rcKeyGuard";

const MOVE_THROTTLE_MS = 40;

export function mapNormFromCanvas(
  e: { clientX: number; clientY: number },
  el: HTMLCanvasElement,
  contentW: number,
  contentH: number,
  fit: "fit" | "actual" | "fill" = "fit",
) {
  const rect = el.getBoundingClientRect();
  const nw = contentW || el.width || 1;
  const nh = contentH || el.height || 1;
  // contain 用 min（letterbox），cover/fill 用 max（溢出裁切）
  const scale =
    fit === "fill"
      ? Math.max(rect.width / nw, rect.height / nh)
      : Math.min(rect.width / nw, rect.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = rect.left + (rect.width - dw) / 2;
  const oy = rect.top + (rect.height - dh) / 2;
  const u = (e.clientX - ox) / dw;
  const v = (e.clientY - oy) / dh;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return {
    x: Math.round(clamp01(u) * 65535),
    y: Math.round(clamp01(v) * 65535),
  };
}

export async function releaseModifiers() {
  // 6 个修饰键 vk
  for (const vk of [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]) {
    try {
      await rcSendInput({ kind: "key", vk, down: false });
    } catch {
      /* 尽力而为 */
    }
  }
  // 鼠标左(1)/右(2)/中(3)键：对端断线时目标机鼠标键会卡住
  for (const button of [1, 2, 3]) {
    try {
      await rcSendInput({ kind: "mouse_button", x: 0, y: 0, button, down: false });
    } catch {
      /* 尽力而为 */
    }
  }
}

export function useRcInput({
  canControl,
  hasFrame,
  contentRef,
  canvasRef,
  screenRef,
  onConfirmEnd,
  fit = "fit",
}: {
  canControl: boolean;
  hasFrame: boolean;
  contentRef: React.MutableRefObject<{ w: number; h: number }>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  screenRef: React.RefObject<HTMLDivElement | null>;
  onConfirmEnd: () => void;
  fit?: "fit" | "actual" | "fill";
}) {
  const [kbOn, setKbOn] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const moveAt = useRef(0);
  const movePending = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<number | null>(null);
  const lockPos = useRef({ x: 32767, y: 32767 });

  const flushMove = useCallback(() => {
    moveTimer.current = null;
    const p = movePending.current;
    movePending.current = null;
    if (!p) return;
    moveAt.current = Date.now();
    void rcSendInput({ kind: "mouse_move", x: p.x, y: p.y });
  }, []);

  const queueMove = useCallback(
    (x: number, y: number) => {
      movePending.current = { x, y };
      const now = Date.now();
      const wait = MOVE_THROTTLE_MS - (now - moveAt.current);
      if (wait <= 0) flushMove();
      else if (moveTimer.current == null) moveTimer.current = window.setTimeout(flushMove, wait);
    },
    [flushMove],
  );

  const norm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const el = canvasRef.current;
      if (!el) return null;
      return mapNormFromCanvas(e, el, contentRef.current.w, contentRef.current.h, fit);
    },
    [canvasRef, contentRef, fit],
  );

  const releaseKb = useCallback(() => {
    setKbOn(false);
    screenRef.current?.blur();
    void releaseModifiers();
  }, [screenRef]);

  const togglePointerLock = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    if (document.pointerLockElement === el) {
      void document.exitPointerLock();
    } else {
      lockPos.current = { x: 32767, y: 32767 };
      void el.requestPointerLock();
    }
  }, [canvasRef]);

  useEffect(() => {
    const onChange = () => {
      const el = canvasRef.current;
      setPointerLocked(!!el && document.pointerLockElement === el);
    };
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, [canvasRef]);

  // 锁定指针：相对位移 → 虚拟归一化坐标
  useEffect(() => {
    if (!pointerLocked || !canControl) return;
    const onMove = (e: MouseEvent) => {
      const sens = 180;
      lockPos.current.x = Math.max(0, Math.min(65535, lockPos.current.x + e.movementX * sens));
      lockPos.current.y = Math.max(0, Math.min(65535, lockPos.current.y + e.movementY * sens));
      queueMove(lockPos.current.x, lockPos.current.y);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [pointerLocked, canControl, queueMove]);

  // 两级 Esc：捕获中先释放键盘；再按确认结束
  useEffect(() => {
    if (!canControl) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSessionEscape(e)) return;
      // 有其它模态时把 Esc 让给它，避免误结束会话。
      // 会话视图本身永远渲染在带 data-rc-root 的 backdrop 内，因此排除自身，
      // 只让「嵌套打开、不带该属性」的模态（如 RcPairDialog）优先拿到 Esc。
      if (document.querySelector(".dialog-backdrop:not([data-rc-root])")) return;
      if (pointerLocked) {
        e.preventDefault();
        e.stopPropagation();
        void document.exitPointerLock();
        return;
      }
      if (kbOn) {
        e.preventDefault();
        e.stopPropagation();
        releaseKb();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onConfirmEnd();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canControl, kbOn, pointerLocked, releaseKb, onConfirmEnd]);

  useEffect(() => {
    return () => {
      if (moveTimer.current != null) window.clearTimeout(moveTimer.current);
    };
  }, []);

  const sendButton = useCallback(
    (e: { clientX: number; clientY: number; button: number }, down: boolean) => {
      if (!canControl || !hasFrame) return;
      if (pointerLocked) {
        const button = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
        void rcSendInput({
          kind: "mouse_button",
          x: lockPos.current.x,
          y: lockPos.current.y,
          button,
          down,
        });
        return;
      }
      const r = norm(e);
      if (!r) return;
      const button = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
      void rcSendInput({ kind: "mouse_button", x: r.x, y: r.y, button, down });
    },
    [canControl, hasFrame, pointerLocked, norm],
  );

  return {
    kbOn,
    setKbOn,
    pointerLocked,
    togglePointerLock,
    releaseKb,
    norm,
    queueMove,
    sendButton,
    lockPos,
  };
}
