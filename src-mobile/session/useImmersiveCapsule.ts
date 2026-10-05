/**
 * useImmersiveCapsule — R2：横屏显式收起，始终有可见把手；不再吞掉画面顶缘输入。
 *
 * 首次引导（design/手机端-横屏工具栏首次引导-设计稿-2026-10-05.html）：
 * 会话内第一次进横屏 → 工具栏自动展开并倒计时教学（teaching）；
 * 教学到点或用户提前收起 → hint（把手脉冲 + 气泡一次性提示）；
 * 用户第一次主动打开工具栏 / 点画面（dismissHint）/ 切回竖屏 → done，本会话不再打扰。
 * 「本会话」= 本 hook 挂载周期（RcMobileSession 以 key=会话 id 挂载，换会话重新教学）；
 * 不做跨会话记忆——每次会话教一次，代价只有 15 秒。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMobileLayout } from "../ui/useMobileLayout";

export const CAPSULE_TEACH_SECONDS = 15;

export type CapsulePhase = "idle" | "teaching" | "hint" | "done";

export function useImmersiveCapsule({ keyboardOpen }: { keyboardOpen: boolean }) {
  const landscape = useMobileLayout();
  const [capsuleVisible, setCapsuleVisible] = useState(false);
  const [phase, setPhase] = useState<CapsulePhase>("idle");
  const [secondsLeft, setSecondsLeft] = useState(CAPSULE_TEACH_SECONDS);
  const everLandscape = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const visibleRef = useRef(capsuleVisible);
  visibleRef.current = capsuleVisible;
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) {
      window.clearTimeout(id);
      window.clearInterval(id);
    }
    timers.current = [];
  }, []);

  // 教学到点 / 用户关掉提示：收回把手态，进入一次性 hint。
  const endTeaching = useCallback(() => {
    clearTimers();
    setCapsuleVisible(false);
    setPhase((p) => (p === "teaching" ? "hint" : p));
  }, [clearTimers]);

  useEffect(() => {
    if (!landscape) {
      // 切回竖屏：教学与提示都到此为止（设计稿的两级取消之一）。
      clearTimers();
      setCapsuleVisible(false);
      setPhase((p) => (p === "idle" ? "idle" : "done"));
      return;
    }
    if (everLandscape.current) return; // 本会话只教一次；StrictMode 双跑也挡在这
    everLandscape.current = true;
    setPhase("teaching");
    setCapsuleVisible(true);
    setSecondsLeft(CAPSULE_TEACH_SECONDS);
    timers.current.push(window.setTimeout(endTeaching, CAPSULE_TEACH_SECONDS * 1000));
    timers.current.push(
      window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000),
    );
    return clearTimers; // 卸载兜底（教学进行中断开/换会话）
  }, [landscape, clearTimers, endTeaching]);

  const toggle = useCallback(() => {
    // 把手是唯一开关：主动打开 = 引导完成；教学期间主动收起 = 让位给 hint。
    clearTimers();
    const opening = !visibleRef.current;
    if (opening) setPhase("done");
    else if (phaseRef.current === "teaching") setPhase("hint");
    setCapsuleVisible(opening);
  }, [clearTimers]);

  // 点画面 / 其他任意交互的收口：只消费 hint，其余相位原样退回（不触发重渲染）。
  const dismissHint = useCallback(() => {
    setPhase((p) => (p === "hint" ? "done" : p));
  }, []);

  return {
    landscape,
    capsuleVisible: keyboardOpen || capsuleVisible,
    phase,
    secondsLeft,
    toggle,
    endTeaching,
    dismissHint,
  };
}
