import { useEffect, useRef, useState } from "react";
import { qualityLabel } from "@/lib/rcQuality";
import type { MobileConnectionInfo } from "./useMobileConnectionInfo";

/** 链路顺畅至少持续这么久才值得建议；抖动中反复建议比不建议更吵。 */
const GOOD_HOLD_MS = 15000;

export interface AutoSuggestToast {
  title: string;
  detail: string;
  accept: () => void;
  dismiss: () => void;
}

/**
 * 实名画质档会永久关掉被控端自动档（2026-10-06 复测 B 的误触陷阱），
 * 链路持续变好后提示一次「切回自动」。同一锁档值只提醒一次；
 * 用户关掉即静默，换档或换会话才重新具备提醒资格。
 * 条件成立时挂真实定时器——只靠依赖变化判定的话，链路一直顺畅反而永远到不了检查点。
 */
export function useAutoSuggestToast(connection: MobileConnectionInfo, lockedQuality: string | null, acceptAuto: () => void): AutoSuggestToast | null {
  const [toast, setToast] = useState<AutoSuggestToast | null>(null);
  const [quietKey, setQuietKey] = useState<string | null>(null);
  const startedAt = useRef(-1);
  // 会话清场先于条件判定（同 useDirectSwitchToast）：声明在后会在挂载拍清掉刚记的起点。
  // quiet 必须是 state：它在渲染期参与 good 计算，ref 被重置不会触发重算。
  useEffect(() => {
    startedAt.current = -1;
    setQuietKey(null);
    setToast(null);
  }, [connection.sessionId]);
  const good = !!lockedQuality && lockedQuality !== "auto" && quietKey !== lockedQuality
    && connection.state === "connected" && connection.pathKind !== "relay" && connection.grade === "ok";
  useEffect(() => {
    if (!good) { startedAt.current = -1; return; }
    if (startedAt.current < 0) startedAt.current = Date.now();
    const wait = Math.max(0, GOOD_HOLD_MS - (Date.now() - startedAt.current));
    const lock = lockedQuality;
    const timer = setTimeout(() => {
      setQuietKey(lock);
      startedAt.current = -1;
      setToast({
        title: "链路已持续顺畅",
        detail: `画质当前锁定在「${qualityLabel(lock)}」。切回自动后，电脑会按链路状况自己选档。`,
        accept: () => { acceptAuto(); setToast(null); },
        dismiss: () => setToast(null),
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [good, lockedQuality, acceptAuto]);
  return toast;
}
