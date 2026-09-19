/**
 * useRcCursor — 远端光标形状同步（P1-6）。
 *
 * 被控端每圈比对一次光标形状，变化才发 `rc-cursor-changed`。
 * 前端映射规则（见 `cursorCssFor`）：
 * - arrow / unknown → 维持 B1 本地 overlay（箭头图标跟手）；
 * - 其它形状 → 用**本地系统光标**按对应 CSS 形状显示（I-beam / 缩放柄 /
 *   禁止……本地渲染即可，无需等画面回传）；
 * - hidden → 光标整体隐藏（远端在游戏/演示里藏了光标）。
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export type RcCursorShape =
  | "arrow"
  | "ibeam"
  | "wait"
  | "cross"
  | "size_nwse"
  | "size_nesw"
  | "size_ns"
  | "size_we"
  | "size_all"
  | "no"
  | "hand"
  | "app_starting"
  | "up_arrow"
  | "hidden"
  | "unknown";

/** 形状 → CSS cursor；None = 用 B1 overlay 箭头。 */
export function cursorCssFor(shape: RcCursorShape | null): string | null {
  switch (shape) {
    case "ibeam":
      return "text";
    case "wait":
      return "wait";
    case "cross":
      return "crosshair";
    case "size_nwse":
      return "nwse-resize";
    case "size_nesw":
      return "nesw-resize";
    case "size_ns":
      return "ns-resize";
    case "size_we":
      return "ew-resize";
    case "size_all":
      return "move";
    case "no":
      return "not-allowed";
    case "hand":
      return "pointer";
    case "app_starting":
      return "progress";
    case "up_arrow":
      return "default";
    case "hidden":
      return "none";
    default:
      return null;
  }
}

export function useRcCursor(sessionId: string): RcCursorShape | null {
  const [shape, setShape] = useState<RcCursorShape | null>(null);
  useEffect(() => {
    setShape(null);
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<{ shape: string }>("rc-cursor-changed", (e) => {
      const s = e.payload?.shape;
      if (typeof s === "string") setShape(s as RcCursorShape);
    }).then((u) => {
      if (!alive) {
        u();
        return;
      }
      unlisten = u;
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [sessionId]);
  return shape;
}
