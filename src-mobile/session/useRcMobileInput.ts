/**
 * useRcMobileInput — 手势判定结果 → 远端 InputEvent 的发送层。
 *
 * 复刻桌面 `useRcInput` 的语义资产（design §6「复用不改」）：16ms 移动节流
 * （绝对坐标 latest-wins）、滚轮 16ms 合并 ±120 量化（sign 对齐桌面
 * RcScreenCanvas：内容下滚 = -120）、按下态跟踪 + releaseAll 兜底补发
 * （防指针在画外/取消/旋转时按键卡死在远端——桌面 pressedButtons/pressedKeys
 * 同款纪律）。节流/合并两只泵在 inputPumps.ts。手机版不复用桌面 hook 本体：
 * 它绑着 pointerLock / IME 等桌面概念，搬过来只会多一堆死分支。
 *
 * 🔴 组合键收口（design §5.2）：修饰键挂起期间发生的「有后果的操作」
 * （点击 / 功能键 / 文本）由 `onComboCompleted` 通知修饰键层补发 up——
 * 滚轮不算组合（Ctrl+滚轮是远端应用自己的缩放手势）。
 *
 * 🔴 发送健康（规则 15.3）：任何发送失败都不得静默——sendChecked 的结果经
 * reportSend 翻转 sendFailed，会话层据此点亮「操作未送达」横幅，恢复后自动
 * 熄灭。手势回调本身不吃异常，但用户必须看得到失败。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RcInputEvent } from "@/lib/api/rcFrameTypes";
import { mapNormFromCanvas } from "@/lib/rcPointer";
import { CLICK_HOVER_MS, SCROLL_MAX_NOTCHES, SCROLL_NOTCH_PX } from "./touchConstants";
import { createMovePump, createWheelPump } from "./inputPumps";
import { sendChecked, sendEvent } from "./sendChannel";

export { sendEvent } from "./sendChannel";

export interface RcMobileInput {
  /** client 坐标 → 归一化 0..65535；无画布返回 null。 */
  norm(clientX: number, clientY: number): { x: number; y: number } | null;
  /** 指针移动（16ms 节流 latest-wins）。 */
  queueMove(clientX: number, clientY: number): void;
  /** 左/右键单击（先即时移动 → CLICK_HOVER_MS 悬停消化 → down+up；右键同路）。 */
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
  /** 显式提交草稿：等待发送结果，失败交由输入区展示。 */
  submitText(text: string): Promise<void>;
  /** 会话设置类事件（键模式/画质/声音），与手势同一发送口与健康监测。 */
  sendRaw(event: RcInputEvent): void;
  /** 全量补发 up（pointercancel / blur / 旋转兜底）。 */
  releaseAll(): void;
  /** 最近一次发送是否失败；恢复成功自动翻回 false。 */
  readonly sendFailed: boolean;
}

export function useRcMobileInput({
  canControl,
  hasFrame,
  canvasRef,
  contentRef,
  onComboCompleted,
  lastInputAt,
}: {
  canControl: boolean;
  hasFrame: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  contentRef: React.RefObject<{ w: number; h: number }>;
  /** 一次「有后果的操作」发出后回调（组合键自动解除）。 */
  onComboCompleted?: () => void;
  /** Epoch clock, shared with useRcFrames for input → next-frame response estimates. */
  lastInputAt?: React.RefObject<number>;
}): RcMobileInput {
  const comboRef = useRef(onComboCompleted);
  comboRef.current = onComboCompleted;
  const inputAtRef = useRef(lastInputAt);
  inputAtRef.current = lastInputAt;
  // 健康位只在翻转时 setState：成功路径（逐帧的 mouse_move）零渲染开销。
  const sendHealthy = useRef(true);
  const [sendFailed, setSendFailed] = useState(false);
  const reportSend = useCallback((ok: boolean) => {
    if (ok === sendHealthy.current) return;
    sendHealthy.current = ok;
    setSendFailed(!ok);
  }, []);
  const send = useCallback(
    (event: RcInputEvent) => sendEvent(event, inputAtRef.current, reportSend),
    [reportSend],
  );

  // 按下态跟踪：只有这里知道哪些键/键位已在远端按下（up 丢失 = 卡键）
  const pressedButtons = useRef<Set<number>>(new Set());
  const pressedKeys = useRef<Set<number>>(new Set());
  const allowed = useRef(canControl && hasFrame);
  allowed.current = canControl && hasFrame;
  const clickTimers = useRef(new Set<number>());
  const scrollRemainder = useRef(0);

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

  const movePump = useMemo(
    () => createMovePump((p) => {
      if (allowed.current) send({ kind: "mouse_move", x: p.x, y: p.y });
    }),
    [send],
  );
  const wheelPump = useMemo(
    () => createWheelPump((p) => {
      if (allowed.current) send({ kind: "wheel", x: p.x, y: p.y, delta: p.delta });
    }),
    [send],
  );

  const queueMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      movePump.queue(r.x, r.y);
    },
    [canControl, hasFrame, norm, movePump],
  );

  const sendButtonAt = useCallback(
    (button: number, down: boolean, clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      if (down) pressedButtons.current.add(button);
      else pressedButtons.current.delete(button);
      send({ kind: "mouse_button", x: r.x, y: r.y, button, down });
    },
    [canControl, hasFrame, norm, send],
  );

  const sendClick = useCallback(
    (button: 1 | 2 | 3, clientX: number, clientY: number) => {
      // 🔴 桌面语义：**先移动再点击**（2026-10-01 真机联调修复）。此前 tap
      // 只发 mouse_button——虽然 down 自带绝对坐标（被控端一次注入完成
      // 「移过去+按下」），但远端窗口没先收到 mouse_move 就没有悬停过程，
      // hover 菜单 / 自定义绘制控件对「无悬停的点击」不响应，用户观感就是
      // 「点别处鼠标不过去、点击没用」。这里补一次**即时**移动（绕开 16ms
      // 节流，保证它排在点击前面），再留 CLICK_HOVER_MS 让远端消息循环消化
      // 悬停，然后才 down+up。坐标仍随 button 下发（双保险：移动丢了点击
      // 落点依然正确）。
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (r) send({ kind: "mouse_move", x: r.x, y: r.y });
      const timer = window.setTimeout(() => {
        clickTimers.current.delete(timer);
        if (!allowed.current) return;
        // 60ms 内已转入拖拽/按压（pressedButtons 有记录）= 该次 down 已占用
        // 按键。再补一套 down/up 会让远端收到重复 down 而 up 只配一次 → 卡键。
        if (pressedButtons.current.has(button)) return;
        sendButtonAt(button, true, clientX, clientY);
        sendButtonAt(button, false, clientX, clientY);
        comboRef.current?.();
      }, CLICK_HOVER_MS);
      clickTimers.current.add(timer);
    },
    [canControl, hasFrame, norm, sendButtonAt, send],
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

  const scrollByFrame = useCallback(
    (dxF: number, dyF: number, clientX: number, clientY: number) => {
      if (!canControl || !hasFrame) return;
      const r = norm(clientX, clientY);
      if (!r) return;
      // 主导轴量化（design §1 ⑥）：自然滚动——手指上滑（dy<0）= 内容下滚 = -120
      const acc = scrollRemainder.current + (Math.abs(dxF) > Math.abs(dyF) ? dxF : dyF);
      const notches = Math.min(SCROLL_MAX_NOTCHES, Math.floor(Math.abs(acc) / SCROLL_NOTCH_PX));
      scrollRemainder.current = acc - Math.sign(acc) * notches * SCROLL_NOTCH_PX;
      if (notches === 0) return;
      wheelPump.push(r.x, r.y, acc > 0 ? 120 * notches : -120 * notches);
    },
    [canControl, hasFrame, norm, wheelPump],
  );

  const sendKeyDown = useCallback((vk: number) => {
    if (!allowed.current) return;
    if (pressedKeys.current.has(vk)) return; // 自动重复拦截（桌面同款）
    pressedKeys.current.add(vk);
    send({ kind: "key", vk, down: true });
  }, [send]);

  const sendKeyUp = useCallback((vk: number) => {
    if (!pressedKeys.current.delete(vk)) return;
    send({ kind: "key", vk, down: false });
  }, [send]);

  const sendKeyPair = useCallback(
    (vk: number) => {
      sendKeyDown(vk);
      sendKeyUp(vk);
      comboRef.current?.();
    },
    [sendKeyDown, sendKeyUp],
  );

  const submitText = useCallback(async (text: string) => {
    if (!allowed.current) throw new Error("当前会话无法输入");
    if (!text) return;
    const submitted = sendChecked({ kind: "text", text }, inputAtRef.current);
    // 松开的是发送当时的组合键，不能等网络返回后误释放新挂起的组合。
    comboRef.current?.();
    await submitted;
  }, []);
  const sendText = useCallback((text: string) => {
    // IME 自动上屏失败没有任何别的出口（提交框的内联错误只覆盖手动提交）。
    void submitText(text).catch(() => reportSend(false));
  }, [submitText, reportSend]);

  const releaseAll = useCallback(() => {
    // 取消在途点击和移动，防止切换模式后旧手势继续操作电脑。
    clickTimers.current.forEach(timer => window.clearTimeout(timer));
    clickTimers.current.clear();
    movePump.clear();
    wheelPump.clear();
    scrollRemainder.current = 0;
    for (const vk of [...pressedKeys.current]) {
      pressedKeys.current.delete(vk);
      send({ kind: "key", vk, down: false });
    }
    for (const button of [...pressedButtons.current]) {
      pressedButtons.current.delete(button);
      send({ kind: "mouse_button", x: 0, y: 0, button, down: false });
    }
  }, [send, movePump, wheelPump]);

  useEffect(() => {
    if (!canControl || !hasFrame) releaseAll();
  }, [canControl, hasFrame, releaseAll]);

  useEffect(
    () => () => {
      movePump.clear();
      wheelPump.clear();
      releaseAll(); // 卸载兜底（对端收口还有 release_all，双保险）
    },
    [releaseAll, movePump, wheelPump],
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
    submitText,
    sendRaw: send,
    releaseAll,
    sendFailed,
  };
}
