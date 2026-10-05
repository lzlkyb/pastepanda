/**
 * useRemoteCursor — 手机端渲染「电脑光标」的位置与形状（B 方案）。
 *
 * 链路：被控端 `input::cursor_telemetry`（一次 `GetCursorInfo` 拿形状 +
 * 归一化位置 + 可见性）→ 控制帧 `{"t":"cursor","s","x","y"}` → 发起端
 * `rc-cursor-changed` 事件 → 这里。
 *
 * 职责边界（与 `touchFeedback` 同一纪律）：
 * - **位置走 DOM 直写**：25Hz 的更新量进 React state 会把会话壳按 25fps
 *   重渲染（画布、工具栏、修饰键条全部跟着），那是纯浪费。位置只写
 *   `style.left/top`，不进渲染树。
 * - **形状走 state**：形状变化是秒级甚至分钟级的事件，用 state 让
 *   `RemoteCursorGlyph` 换图形正好。
 * - **第一次收到位置前不显示**：没有位置就渲染，光标会出现在 (0,0)
 *   （左上角）——那比不显示更糟，用户会以为电脑光标真的在角落。
 *
 * `x/y` 缺省 = 对端此刻不可见（`hidden` 或旧版被控端只发形状）。
 * 后者（老协议）保持本地环的行为，不显示远端光标。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { mapNormToClient } from "@/lib/rcPointer";
import type { RcCursorPayload, RcCursorShape } from "@/hooks/useRcCursor";
import { VIEWPORT_CHANGED } from "../video/PinchViewport";

export interface RemoteCursor {
  shape: RcCursorShape;
  /** 已定位（收到过 x/y 且可见）——false 时元素应保持隐藏。 */
  placed: boolean;
}

export function useRemoteCursor({
  enabled,
  canvasRef,
  contentRef,
  cursorRef,
  surfaceRef,
  onPosition,
}: {
  /** 会话模式才开；沙盒模式（无 rc_drain_frames）没有遥测可收。 */
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  contentRef: React.RefObject<{ w: number; h: number }>;
  cursorRef: React.RefObject<HTMLDivElement | null>;
  surfaceRef?: React.RefObject<HTMLElement | null>;
  onPosition?: (x: number, y: number) => void;
}): RemoteCursor {
  const [shape, setShape] = useState<RcCursorShape>("arrow");
  const positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  // placed 不进渲染依赖：它只由事件回调推。用 ref 持有是为了卸载/失效时
  // 把元素收起，不必依赖一次重渲染。
  const placedRef = useRef(false);
  const lastPosition = useRef<{ x: number; y: number } | null>(null);
  const [, forceRepaint] = useState(0);

  const place = useCallback(
    (x: number, y: number) => {
      const el = cursorRef.current;
      const canvas = canvasRef.current;
      if (!el || !canvas) return;
      // offsetParent = 手势面（position:relative 的容器），与光标环同一层：
      // 环在 client 坐标里算，这里在 canvas 的**实时**矩形里算——矩形取自
      // getBoundingClientRect，捏合缩放/平移后依然对得上被缩放过的画面。
      const parent = el.offsetParent as HTMLElement | null;
      const base = parent?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
      const p = mapNormToClient(
        x,
        y,
        canvas,
        contentRef.current?.w ?? 0,
        contentRef.current?.h ?? 0,
        "fit",
      );
      el.style.left = `${p.clientX - base.left}px`;
      el.style.top = `${p.clientY - base.top}px`;
      if (!placedRef.current) {
        placedRef.current = true;
        el.classList.add("isOn");
        forceRepaint(n => n + 1);
      }
    },
    [canvasRef, contentRef, cursorRef],
  );

  useEffect(() => {
    const el = cursorRef.current;
    if (!enabled) {
      // 会话结束/沙盒：收起并复位，别把上一场的光标留给下一场
      placedRef.current = false;
      lastPosition.current = null;
      setShape("arrow");
      el?.classList.remove("isOn");
      return;
    }
    let alive = true;
    let unlisten: (() => void) | undefined;
    const reproject = () => {
      const p = lastPosition.current;
      if (alive && p) place(p.x, p.y);
    };
    const surface = surfaceRef?.current;
    const canvas = canvasRef.current;
    surface?.addEventListener(VIEWPORT_CHANGED, reproject);
    window.addEventListener("resize", reproject);
    const observer = new ResizeObserver(reproject);
    if (canvas instanceof Element) observer.observe(canvas);
    if (surface) observer.observe(surface);
    const frameSize = new MutationObserver(reproject);
    if (canvas instanceof Element) frameSize.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    void listen<RcCursorPayload>("rc-cursor-changed", (e) => {
      const s = e.payload?.shape;
      if (typeof s !== "string") return;
      if (!alive) return;
      setShape(s as RcCursorShape);
      const { x, y } = e.payload;
      if (typeof x === "number" && typeof y === "number") {
        lastPosition.current = { x, y };
        positionCallback.current?.(x, y);
        place(x, y);
      } else {
        lastPosition.current = null;
        if (!placedRef.current) return;
        // 远端把光标藏了 / 取不到位置：收起，不把光标摆在最后一次的位置说谎
        placedRef.current = false;
        cursorRef.current?.classList.remove("isOn");
        forceRepaint(n => n + 1);
      }
    })
      .then((u) => {
        if (!alive) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch((e) =>
        logger.warn("[RcCursor] rc-cursor-changed 监听注册失败，手机端看不到电脑光标", e),
      );
    return () => {
      alive = false;
      surface?.removeEventListener(VIEWPORT_CHANGED, reproject);
      window.removeEventListener("resize", reproject);
      observer.disconnect();
      frameSize.disconnect();
      unlisten?.();
    };
  }, [enabled, place, cursorRef, canvasRef, surfaceRef]);

  return { shape, placed: placedRef.current };
}
