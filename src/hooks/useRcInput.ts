/**
 * useRcInput — 鼠标节流、指针锁定相对位移、两级 Esc、键盘捕获、本地光标。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcSendInput } from "@/lib/api/rc";
import { isSessionEscape, shouldSwallowEscape } from "@/lib/rcKeyGuard";
import { rcPanelOpenCount } from "@/lib/rcPanelFocus";
import { keyToVk, shouldForwardToRemote } from "@/lib/rcKeyMap";
// 几何换算收口在 lib/rcPointer（2026-09-22 拆出，本文件压回 400 行内）。
// re-export 保持既有 import 路径（@/hooks/useRcInput）不变。
import { mapNormFromCanvas, type RcCursorPos } from "@/lib/rcPointer";
export { mapNormFromCanvas };
export type { RcCursorPos };

// 16ms = 60Hz：P0-3 输入提速。绝对坐标 latest-wins，高频率只有好处；
// 数据报通道下每拍都进得来，可靠流场景也只是多几个小 JSON 帧。
// P4：fps120 档降到 8ms（datagram 本就不排队，纯采样密度问题）。
const MOVE_THROTTLE_MS = 16;
// 滚轮合并发送周期：触控板一拍可产生上百个 wheel 事件，逐条转发 = IPC +
// 可靠流洪泛；16ms 内的滚动合成一条（方向可能混合，delta 直接累加）。
const WHEEL_THROTTLE_MS = 16;

/**
 * 修饰键兜底：松开六个修饰键（避免焦点切换后对端卡在 Ctrl/Shift）。
 *
 * 🔴 这里**不再**盲发鼠标左/右/中的 up（2026-09-22 删）。旧实现无条件补发三个
 * 鼠标 up，而本函数挂在画面区 `.fakeScreen` 的 onBlur 上——用户每次点底栏/顶栏
 * 按钮（焦点离开画面）都会触发一次。远端收到**孤立的** RBUTTONUP 时，Windows 会
 * 由 WM_RBUTTONUP 生成 WM_CONTEXTMENU（DefWindowProc 行为），表现就是「没碰右键
 * 却弹出右键菜单」；`inbound.rs` 里那句「若恰有卡住的右键，右键菜单还会在那里
 * 凭空弹出」说的就是这个坑。
 *
 * 鼠标的按下态兜底交给 [`useRcInput`] 返回的 `releaseTracked()`：它按
 * `pressedButtons` 精确跟踪，只补发**真的按下过**的键。两个调用点
 * （`RcSessionStage` 的 onBlur、`releaseKb`）本来就是成对调用的，
 * 而 `useRcDisplayMode` 的换会话卸载点**不该**再往旧会话发东西。
 */
export async function releaseModifiers() {
  // 6 个修饰键 vk
  for (const vk of [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]) {
    try {
      await rcSendInput({ kind: "key", vk, down: false });
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
  moveThrottleMs = MOVE_THROTTLE_MS,
  inputEpochRef,
}: {
  canControl: boolean;
  hasFrame: boolean;
  contentRef: React.MutableRefObject<{ w: number; h: number }>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  screenRef: React.RefObject<HTMLDivElement | null>;
  onConfirmEnd: () => void;
  fit?: "fit" | "actual" | "fill";
  /** P4：fps120 档传 8，其余默认 16。 */
  moveThrottleMs?: number;
  /** P4：每次输入（移动/按键/点击）发出的本地时刻。操作延迟 HUD 用，可缺省。 */
  inputEpochRef?: React.MutableRefObject<number>;
}) {
  const [kbOn, setKbOn] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  // B1：本地光标。发送坐标（归一化 0..65535）在这里是唯一汇合点
  // （普通模式与指针锁定模式都走 queueMove），所以光标状态也在这更新——
  // 视觉跟随本地输入即时移动，不等对端画面回传（那是 200-400ms 的"飘"）。
  const [cursor, setCursor] = useState<RcCursorPos | null>(null);
  const [cursorPressed, setCursorPressed] = useState(false);
  const moveAt = useRef(0);
  const movePending = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<number | null>(null);
  const lockPos = useRef({ x: 32767, y: 32767 });
  /**
   * 已向对端发出「按下」且还没等到「抬起」的鼠标键（1=左 2=右 3=中）。
   * 🔴 canvas 只在按下的那一刻收到 mousedown；若用户把指针拖出画面才松开
   * （letterbox / HUD / 窗口外 / Alt-Tab），canvas 的 onMouseUp 不会触发，
   * 按键就卡死在远端——右键卡死后，任何补发的 UP 都会在远端弹出右键菜单
   * （「误触右键菜单」的根源）。这里跟踪按下态，window 级 mouseup / blur
   * 兜底补发 UP（见下方 effect）。
   */
  const pressedButtons = useRef<Set<number>>(new Set());
  /**
   * 已向对端发出「按下」且还没等到「抬起」的键盘 VK。
   * 🔴 与鼠标同款：keyup 丢失 = 按键卡死在远端。blur/Esc/卸载时由
   * `releaseTracked` 全量补发——releaseModifiers 只管修饰键兜底，
   * 普通键（按住 W 切出去 → 角色一直走）只有这里有数。
   * 自动重复（OS 连发 keydown）也靠它拦：已在按下态就不再转发。
   */
  const pressedKeys = useRef<Set<number>>(new Set());
  const wheelPending = useRef<{ x: number; y: number; delta: number } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const lastWheelAt = useRef(0);
  /**
   * 「有后果的操作」时间戳（点击 / 按键 / 滚轮）。
   *
   * 🔴 刻意**不含鼠标移动**：划过画面属于查看行为，对端本来就不该有反应；
   *    把它记进来会让「操作后画面无响应」变成新的误报源
   *    （判据见 `rcSessionStats.actionUnansweredMs`）。
   */
  const lastActionAt = useRef(0);

  const flushMove = useCallback(() => {
    moveTimer.current = null;
    const p = movePending.current;
    movePending.current = null;
    if (!p) return;
    moveAt.current = Date.now();
    if (inputEpochRef) inputEpochRef.current = moveAt.current;
    void rcSendInput({ kind: "mouse_move", x: p.x, y: p.y }).catch(() => {});
  }, [inputEpochRef]);

  const queueMove = useCallback(
    (x: number, y: number) => {
      // B1：光标跟着**想要发出去**的坐标走（节流只延迟信令，不延迟视觉）
      setCursor({ u: x / 65535, v: y / 65535 });
      movePending.current = { x, y };
      const now = Date.now();
      const wait = moveThrottleMs - (now - moveAt.current);
      if (wait <= 0) flushMove();
      else if (moveTimer.current == null) moveTimer.current = window.setTimeout(flushMove, wait);
    },
    [flushMove, moveThrottleMs],
  );

  const norm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const el = canvasRef.current;
      if (!el) return null;
      return mapNormFromCanvas(e, el, contentRef.current.w, contentRef.current.h, fit);
    },
    [canvasRef, contentRef, fit],
  );

  /** 记一次「有后果的操作」。键盘/滚轮在 `RcSessionView` 里调用它。 */
  const noteAction = useCallback(() => {
    // 🔴 C3：performance.now 域——唯一消费者是 `useRcLinkState` 的「操作未响应」
    // 判据，它拿的是 `lastFrameAt`（同为 perf 域）；别处记的 `inputEpochRef`
    // 才是 epoch 域（给画面延迟用），两域不许互比。
    lastActionAt.current = performance.now();
  }, []);

  /** M4：滚轮也要记操作时刻——「操作 ≈Nms」的响应样本不能漏掉滚动。 */
  const noteWheel = useCallback(() => {
    noteAction();
    if (inputEpochRef) inputEpochRef.current = Date.now();
  }, [noteAction, inputEpochRef]);

  /**
   * 把本端跟踪的「已按下」键/鼠标键全部补发 up（Esc / 失焦 / 卸载兜底）。
   * 与 `releaseModifiers` 的区别：它只管固定六个修饰键 + 鼠标，
   * 这里管**实际发出去过的每一颗键**——普通键卡死只有这份跟踪能救。
   * 对端收到的多余 up 是无害 no-op（没有对应的 down）。
   */
  const releaseTracked = useCallback(() => {
    for (const vk of [...pressedKeys.current]) {
      pressedKeys.current.delete(vk);
      void rcSendInput({ kind: "key", vk, down: false }).catch(() => {});
    }
    for (const button of [...pressedButtons.current]) {
      pressedButtons.current.delete(button);
      void rcSendInput({ kind: "mouse_button", x: 0, y: 0, button, down: false }).catch(() => {});
    }
  }, []);

  const flushWheel = useCallback(() => {
    wheelTimer.current = null;
    const p = wheelPending.current;
    wheelPending.current = null;
    if (!p) return;
    lastWheelAt.current = Date.now();
    void rcSendInput({ kind: "wheel", x: p.x, y: p.y, delta: p.delta }).catch(() => {});
  }, []);

  /** 滚轮（合并发送）：16ms 内的滚动合成一条，delta 累加、坐标取最新。 */
  const sendWheel = useCallback(
    (x: number, y: number, delta: number) => {
      const prev = wheelPending.current;
      wheelPending.current = { x, y, delta: (prev?.delta ?? 0) + delta };
      const wait = WHEEL_THROTTLE_MS - (Date.now() - lastWheelAt.current);
      if (wait <= 0) flushWheel();
      else if (wheelTimer.current == null) {
        wheelTimer.current = window.setTimeout(flushWheel, wait);
      }
    },
    [flushWheel],
  );

  const releaseKb = useCallback(() => {
    setKbOn(false);
    screenRef.current?.blur();
    void releaseModifiers();
    // 修饰键之外的普通键：blur 事件本身不携带键状态，这里主动清
    releaseTracked();
  }, [screenRef, releaseTracked]);

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

  // 按下态兜底：mouseup 发生在 canvas 外（letterbox / HUD / 窗口外）时，
  // canvas 的 onMouseUp 收不到，在 window 上补发 UP；整窗失焦（Alt-Tab）
  // 时把所有按着的键全部松开。正常路径下 canvas 的 onMouseUp 先清掉按下态，
  // 这里的监听是 no-op——不会双发。
  useEffect(() => {
    if (!canControl) return;
    const releaseOne = (button: number, e?: MouseEvent) => {
      const r = e && !pointerLocked ? norm(e) : null;
      void rcSendInput({
        kind: "mouse_button",
        x: pointerLocked ? lockPos.current.x : (r?.x ?? 0),
        y: pointerLocked ? lockPos.current.y : (r?.y ?? 0),
        button,
        down: false,
      }).catch(() => {});
    };
    const onUp = (e: MouseEvent) => {
      // 侧键（3/4）从未被跟踪，直接放行
      if (e.button === 3 || e.button === 4) return;
      const button = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
      if (!pressedButtons.current.has(button)) return;
      pressedButtons.current.delete(button);
      // 🔴 再审计（2026-09-25）：画外松开走这里兜底补发 UP，但本地光标的
      // 按压态此前不复位（sendButton 的 down=true 已把它置真，画外的 up
      // 到不了 canvas 的 React onMouseUp）——假光标永久显示按下形状。
      setCursorPressed(false);
      releaseOne(button, e);
    };
    const onBlur = () => {
      // 整窗失焦（Alt-Tab）：键盘 + 鼠标的按下态一起清。
      // 🔴 cursorPressed 同理复位（releaseTracked 只清对端注入态）。
      releaseTracked();
      setCursorPressed(false);
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [canControl, pointerLocked, norm, releaseTracked]);

  // 两级 Esc：捕获中先释放键盘；再按确认结束。
  // 2026-09-23：只看档不再整段早退——它没有键盘/指针锁可释放，Esc 天然
  // 落到「确认结束」这一级，给只看会话一条键盘退出加速路径（顶栏按钮仍是
  // 鼠标主路，规则 17.1）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSessionEscape(e)) return;
      // 有其它模态时把 Esc 让给它，避免误结束会话。
      // 会话视图本身永远渲染在带 data-rc-root 的 backdrop 内，因此排除自身，
      // 只让「嵌套打开、不带该属性」的模态（如 RcPairDialog）优先拿到 Esc。
      if (document.querySelector(".dialog-backdrop:not([data-rc-root])")) return;
      // 🔴 再审计（Esc 两级取消，2026-09-25）：画质/画面下拉、⋯ 面板、HUD 明细
      // 展开时（rcPanelFocus 计数 >0），Esc 的第一级归面板自己（收起面板，计数
      // 在面板 effect cleanup 里归零），这里直接让路——否则会直落「结束会话」
      // 确认，违反规则 17.6。收完后再按 Esc 才走结束确认。
      if (rcPanelOpenCount() > 0) return;
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
      if (wheelTimer.current != null) window.clearTimeout(wheelTimer.current);
      // 卸载兜底：按住键/鼠标键退出会话视图时补发 up（对端收口还会
      // release_all，双保险不冲突）
      releaseTracked();
    };
  }, [releaseTracked]);

  const sendButton = useCallback(
    (e: { clientX: number; clientY: number; button: number }, down: boolean) => {
      if (!canControl || !hasFrame) return;
      // DOM button 3/4 = 鼠标侧键（后退/前进）：后端没有 XBUTTON 注入，
      // 必须直接忽略——落到 else 会变成左键点到远端
      if (e.button === 3 || e.button === 4) return;
      noteAction();
      if (inputEpochRef) inputEpochRef.current = Date.now();
      setCursorPressed(down);
      // DOM e.button：0=左 1=中 2=右 → 协议 1=左 2=右 3=中
      const button = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
      if (down) pressedButtons.current.add(button);
      else pressedButtons.current.delete(button);
      if (pointerLocked) {
        void rcSendInput({
          kind: "mouse_button",
          x: lockPos.current.x,
          y: lockPos.current.y,
          button,
          down,
        }).catch(() => {});
        return;
      }
      const r = norm(e);
      if (!r) return;
      void rcSendInput({ kind: "mouse_button", x: r.x, y: r.y, button, down }).catch(() => {});
    },
    [canControl, hasFrame, pointerLocked, norm, noteAction, inputEpochRef],
  );

  // 键盘捕获/转发（从 RcSessionView 收口进来）：捕获态下 Esc 本地消费，
  // 其余按键查 vk 表转发。挂 fakeScreen 的 onKeyDown/onKeyUp 用。
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!canControl || !kbOn) return;
      if (isSessionEscape(e) && shouldSwallowEscape(kbOn, pointerLocked, canControl)) return;
      if (!shouldForwardToRemote(e)) return;
      const vk = keyToVk(e);
      if (vk == null) return;
      e.preventDefault();
      e.stopPropagation();
      // 自动重复拦截：按住键时 OS 连发 keydown（~30/s），已在按下态就不再
      // 转发——真松开必有 keyup 清档，重新按下（tap-tap）不受影响
      if (pressedKeys.current.has(vk)) return;
      noteAction();
      if (inputEpochRef) inputEpochRef.current = Date.now();
      pressedKeys.current.add(vk);
      void rcSendInput({ kind: "key", vk, down: true }).catch(() => {});
    },
    [canControl, kbOn, pointerLocked, noteAction, inputEpochRef],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (!canControl || !kbOn) return;
      if (isSessionEscape(e) && shouldSwallowEscape(kbOn, pointerLocked, canControl)) return;
      const vk = keyToVk(e);
      if (vk == null) return;
      e.preventDefault();
      e.stopPropagation();
      pressedKeys.current.delete(vk);
      void rcSendInput({ kind: "key", vk, down: false }).catch(() => {});
    },
    [canControl, kbOn, pointerLocked],
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
    lastActionAt,
    noteAction,
    noteWheel,
    sendWheel,
    releaseTracked,
    /** 键盘捕获/转发 handlers（挂 fakeScreen）。 */
    onKeyDown,
    onKeyUp,
    /** B1：本地光标位置（内容坐标 0..1）；null = 还没动过，不渲染。 */
    cursor,
    cursorPressed,
  };
}
