/**
 * useRcCursor — 远端光标形状同步（P1-6 + B 方案位置字段，2026-10-02）。
 *
 * 被控端每圈比对一次光标遥测，变化才发 `rc-cursor-changed`（形状 + 归一化
 * 位置）。形状 → 本地光标样式的映射规则见 `lib/utils.ts` 的 `cursorCssFor`
 * （桌面/手机共用的单一数据源，规则 11）：
 * - arrow / unknown → 维持 B1 本地 overlay（箭头图标跟手）；
 * - 其它形状 → 用**本地系统光标**按对应 CSS 形状显示（I-beam / 缩放柄 /
 *   禁止……本地渲染即可，无需等画面回传）；
 * - hidden → 光标整体隐藏（远端在游戏/演示里藏了光标）。
 *
 * 桌面**只消费形状**：桌面用户的物理鼠标就是远端鼠标， overlay 箭头跟着
 * 本地指针走已经是对的；遥测里的位置字段留给手机端（那只手不是远端光标）。
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";

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

/** rc-cursor-changed 的事件载荷（B 方案在形状之外带了归一化位置）。 */
export interface RcCursorPayload {
  shape: string;
  /** 抓帧范围内的 0..=65535 归一化；缺省 = 对端此刻不可见。 */
  x?: number;
  y?: number;
}

export function useRcCursor(sessionId: string): RcCursorShape | null {
  const [shape, setShape] = useState<RcCursorShape | null>(null);
  useEffect(() => {
    setShape(null);
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<RcCursorPayload>("rc-cursor-changed", (e) => {
      const s = e.payload?.shape;
      if (typeof s === "string") setShape(s as RcCursorShape);
    })
      .then((u) => {
        if (!alive) {
          u();
          return;
        }
        unlisten = u;
      })
      // 审计修（对齐 useRcSessionNotices 的写法）：listen 的拒绝必须留痕，
      // 不能变成 unhandled rejection 后静默丢掉整条光标同步链路。
      .catch((e) => logger.warn("[RcCursor] rc-cursor-changed 监听注册失败，远端光标形状不会同步", e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [sessionId]);
  return shape;
}
