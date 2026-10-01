/**
 * useRcMobileInput — 手势判定结果 → 远端 InputEvent 的发送层。
 *
 * 复刻桌面 `useRcInput` 的语义资产（design §6「复用不改」）：16ms 移动节流
 * （绝对坐标 latest-wins）、滚轮 16ms 合并 ±120 量化（sign 对齐桌面
 * RcScreenCanvas：内容下滚 = -120）、按下态跟踪 + releaseAll 兜底补发
 * （防指针在画外/取消/旋转时按键卡死在远端——桌面 pressedButtons/pressedKeys
 * 同款纪律）。手机版不复用桌面 hook 本体：它绑着 pointerLock / IME 等
 * 桌面概念，搬过来只会多一堆死分支。
 *
 * 🔴 组合键收口（design §5.2）：修饰键挂起期间发生的「有后果的操作」
 * （点击 / 功能键 / 文本）由 `onComboCompleted` 通知修饰键层补发 up——
 * 滚轮不算组合（Ctrl+滚轮是远端应用自己的缩放手势）。
 */
import { useCallback, useEffect, useRef } from "react";
import { rcSendInput } from "@/lib/api/rcCommands";
import type { RcInputEvent } from "@/lib/api/rcFrameTypes";
import { mapNormFromCanvas } from "@/lib/rcPointer";
import { MOVE_THROTTLE_MS, SCROLL_MAX_NOTCHES, SCROLL_NOTCH_PX, WHEEL_MERGE_MS } from "./touchConstants";

/**
 * 安全发送：无 Tauri 环境（纯浏览器联调沙盒）下 invoke 同步抛错，
 * 不能让它打断手势回调；有会话时对端语义负责吞掉无主事件。
 * 会话壳的 set_key_mode / set_quality / audio_on 也走这条（单一收口）。
 */
export function sendEvent(event: RcInputEvent): void {
  try {
    void rcSendInput(event).catch(() => {});
  } catch {
    /* 纯浏览器联调：静默 */
  }
}

export interface RcMobileInput {
  /** client 坐标 → 归一化 0..65535；无画布返回 null。 */
  norm(clientX: number, clientY: number): { x: number; y: number } | null;
  /** 指针移动（16ms 节流 latest-wins）。 */
  queueMove(clientX: number, clientY: number): void;
  /** 左/右键单击（down+up 原子对；mouse_button 自带坐标，远端定位+点击一步）。 */
  sendClick(button: 1 | 2 | 3, clientX: number, clientY: number): void;
  /** 拖拽：down → move → up 三段必须成对（内部跟踪按下态）。 */
  dragDown(clientX: number, clientY: number): void;
  dragUp(clientX: number, clientY: number): void;
  /** 双指滚动一帧（手指方向 CSS 像素）；内部量化 +120/-120 并 16ms 合并。 */
  scrollByFrame(dxF: number, dyF: number, clientX: number, clientY: number): void;
  /** 功能键/修饰键 down-up 对（组合键完成回调见构造参数）。 */
  sendKeyPair(vk: number): void;
  sendKeyDown(vk: number): void;
  sendKeyUp(vk: number): void;
  /** 打字档整串文本（乙-① KEYEVENTF_UNICODE 通道）。 */
  sendText(text: string): void;
  /** 全量补发 up（pointercancel / blur / 旋转兜底）。 */
  releaseAll(): void;
}

export function useRcMobileInput({
  canControl,
  hasFrame,
  canvasRef,
  contentRef,
  onComboCompleted,
}: {
  canControl: boolean;
  hasFrame: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  contentRef: React.RefObject<{ w: number; h: number }>;
  /** 一次「有后果的操作」发出后回调（组合键自动解除）。 */
  onComboCompleted?: () => void;
}): RcMobileInput {
  const comboRef = useRef(onComboCompleted);
  comboRef.current = onComboCompleted;

  // 按下态跟踪：只有这里知道哪些键/键位已在远端按下（up 丢失 = 卡键）
  const pressedButtons = useRef<Set<number>>(new Set());
  const pressedKeys = useRef<Set<number>>(new Set());

  // 移动节流（桌面 queueMove 同构）
  const moveAt = useRef(0);
  const movePending = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<number | null>(null);

  // 滚轮合并（桌面 sendWheel 同构：16ms 内 delta 累加、坐标取最新）
  const wheelPending = useRef<{ x: number; y: number; delta: number } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const lastWheelAt = useRef(0);

  const norm = useCallback(
    (clientX: number, clientY: number) => {
      const el = canvasRef.current;
      if (!el) return null;
      return mapNormFromCanvas(
        { clientX, clientY },
        el,
        contentRef.current?.w ?? 0,
        contentRef.current?.h ?? 0,
        "fit",
      );
    },
    [canvasRef, contentRef],
  );

  const flushMove = useCallback(() => {
    moveTimer.current = null;
    const p = movePending.current;
    movePending.current = null;
    if (!p) return;
    sendEvent({ kind: "mouse_move", x: p.x, y: p.y });
  }, []);

  const queueMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      movePending.current = r;
      const wait = MOVE_THROTTLE_MS - (Date.now() - moveAt.current);
      if (wait <= 0) {
        moveAt.current = Date.now();
        flushMove();
      } else if (moveTimer.current == null) {
        moveTimer.current = window.setTimeout(flushMove, wait);
      }
    },
    [canControl, hasFrame, norm, flushMove],
  );

  const sendButtonAt = useCallback(
    (button: number, down: boolean, clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      if (down) pressedButtons.current.add(button);
      else pressedButtons.current.delete(button);
      sendEvent({ kind: "mouse_button", x: r.x, y: r.y, button, down });
    },
    [canControl, hasFrame, norm],
  );

  const sendClick = useCallback(
    (button: 1 | 2 | 3, clientX: number, clientY: number) => {
      sendButtonAt(button, true, clientX, clientY);
      sendButtonAt(button, false, clientX, clientY);
      comboRef.current?.();
    },
    [sendButtonAt],
  );

  const dragDown = useCallback(
    (clientX: number, clientY: number) => {
      sendButtonAt(1, true, clientX, clientY);
    },
    [sendButtonAt],
  );
  const dragUp = useCallback(
    (clientX: number, clientY: number) => {
      if (!pressedButtons.current.has(1)) return; // 无 down 不补 up（与桌面同纪律）
      sendButtonAt(1, false, clientX, clientY);
    },
    [sendButtonAt],
  );

  const flushWheel = useCallback(() => {
    wheelTimer.current = null;
    const p = wheelPending.current;
    wheelPending.current = null;
    if (!p) return;
    lastWheelAt.current = Date.now();
    sendEvent({ kind: "wheel", x: p.x, y: p.y, delta: p.delta });
  }, []);

  const scrollByFrame = useCallback(
    (dxF: number, dyF: number, clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      // 主导轴量化（design §1 ⑥）：自然滚动——手指上滑（dy<0）= 内容下滚 = -120
      const acc = Math.abs(dxF) > Math.abs(dyF) ? dxF : dyF;
      const notches = Math.min(SCROLL_MAX_NOTCHES, Math.floor(Math.abs(acc) / SCROLL_NOTCH_PX));
      if (notches === 0) return;
      const delta = acc > 0 ? 120 * notches : -120 * notches;
      const prev = wheelPending.current;
      wheelPending.current = {
        x: r.x,
        y: r.y,
        delta: (prev?.delta ?? 0) + delta,
      };
      const wait = WHEEL_MERGE_MS - (Date.now() - lastWheelAt.current);
      if (wait <= 0) flushWheel();
      else if (wheelTimer.current == null) wheelTimer.current = window.setTimeout(flushWheel, wait);
    },
    [canControl, hasFrame, norm, flushWheel],
  );

  const sendKeyDown = useCallback((vk: number) => {
    if (pressedKeys.current.has(vk)) return; // 自动重复拦截（桌面同款）
    pressedKeys.current.add(vk);
    sendEvent({ kind: "key", vk, down: true });
  }, []);

  const sendKeyUp = useCallback((vk: number) => {
    if (!pressedKeys.current.delete(vk)) return;
    sendEvent({ kind: "key", vk, down: false });
  }, []);

  const sendKeyPair = useCallback(
    (vk: number) => {
      sendKeyDown(vk);
      sendKeyUp(vk);
      comboRef.current?.();
    },
    [sendKeyDown, sendKeyUp],
  );

  const sendText = useCallback((text: string) => {
    if (!text) return;
    sendEvent({ kind: "text", text });
    comboRef.current?.();
  }, []);

  const releaseAll = useCallback(() => {
    for (const vk of [...pressedKeys.current]) {
      pressedKeys.current.delete(vk);
      sendEvent({ kind: "key", vk, down: false });
    }
    for (const button of [...pressedButtons.current]) {
      pressedButtons.current.delete(button);
      sendEvent({ kind: "mouse_button", x: 0, y: 0, button, down: false });
    }
  }, []);

  useEffect(
    () => () => {
      if (moveTimer.current != null) window.clearTimeout(moveTimer.current);
      if (wheelTimer.current != null) window.clearTimeout(wheelTimer.current);
      releaseAll(); // 卸载兜底（对端收口还有 release_all，双保险）
    },
    [releaseAll],
  );

  return {
    norm,
    queueMove,
    sendClick,
    dragDown,
    dragUp,
    scrollByFrame,
    sendKeyPair,
    sendKeyDown,
    sendKeyUp,
    sendText,
    releaseAll,
  };
}
