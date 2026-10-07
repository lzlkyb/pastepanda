import { useEffect, useRef, useState } from "react";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";

/** 中继至少停留这么久才值得播报「已切回直连」；抖动几秒的闪变不弹。 */
const RELAY_HOLD_MS = 5000;

export interface DirectSwitchToast {
  title: string;
  detail: string;
  dismiss: () => void;
}

/**
 * 中继→直连的正向转折播报（一次性/每次中继停留各一次）：
 * 坏路径有徽章常驻告知，坏→好的转折用户只能靠画面慢慢变清楚自己猜。
 */
export function useDirectSwitchToast(connection: MobileConnectionInfo): DirectSwitchToast | null {
  const [toast, setToast] = useState<DirectSwitchToast | null>(null);
  const relaySince = useRef(-1); // -1 = 不在中继；0 不能当哨兵（假时钟下 Date.now() 从 0 起步）。
  // 会话清场必须先于路径判定执行（同一提交内 effect 按声明序跑），
  // 否则挂载/换会话那拍「先记时间戳、再被清零」，中继起点就丢了。
  useEffect(() => {
    relaySince.current = -1;
    setToast(null);
  }, [connection.sessionId]);
  useEffect(() => {
    if (connection.state === "reconnecting" || connection.state === "failed") return;
    if (connection.pathKind === "relay") {
      if (relaySince.current < 0) relaySince.current = Date.now();
      return;
    }
    const held = relaySince.current;
    relaySince.current = -1;
    if (held < 0 || connection.state !== "connected") return;
    if (connection.pathKind !== "direct" && connection.pathKind !== "lan") return;
    if (Date.now() - held < RELAY_HOLD_MS) return;
    setToast({ title: "已切回直连", detail: "延时会自动回落，画质随后回升。", dismiss: () => setToast(null) });
  }, [connection.pathKind, connection.state]);
  return toast;
}
