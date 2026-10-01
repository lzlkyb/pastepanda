/**
 * useImmersiveCapsule — 横屏沉浸：工具条自动隐藏 + 顶缘热区唤出（design §5.5）。
 *
 * 参数与隐藏态纪律照搬桌面 useRcCapsuleReveal（顶缘热区 / 2.5s 淡出 / 首显
 * 15s / pointer-events:none + visibility:hidden + 不进 Tab 环），只换触发手型：
 * 触摸没有 hover，dwell 不适用 → 点按热区即唤出；顶缘滑动手势被系统通知栏
 * 收走，不可用。
 *
 * 🔴 热区点按必须本地吃掉、绝不转发：interceptDown 由会话壳在手势状态机
 * 之前调用（输入分发顺序 = 热区判定 → 手势状态机 → 远端，规则 11.1 收口）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CAPSULE_FADE_MS, CAPSULE_FIRST_SHOW_MS, HOT_ZONE_PX } from "./touchConstants";

export function useImmersiveCapsule({ keyboardOpen }: { keyboardOpen: boolean }) {
  const [landscape, setLandscape] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: landscape)").matches,
  );
  const [capsuleVisible, setCapsuleVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const firstShowDone = useRef(false);
  const keyboardOpenRef = useRef(keyboardOpen);
  keyboardOpenRef.current = keyboardOpen;

  const clearHide = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHide();
    if (keyboardOpenRef.current) return; // 软键盘打开期间不隐藏（与修饰键条成对存在）
    hideTimer.current = window.setTimeout(() => setCapsuleVisible(false), CAPSULE_FADE_MS);
  }, [clearHide]);

  /** 顶缘热区判定：横屏且触点在顶缘 HOT_ZONE_PX 内 → 唤出并本地消费。 */
  const interceptDown = useCallback(
    (clientY: number, surfaceTop: number) => {
      if (!landscape) return false;
      if (clientY - surfaceTop > HOT_ZONE_PX) return false;
      setCapsuleVisible(true);
      scheduleHide();
      return true;
    },
    [landscape, scheduleHide],
  );

  /** 胶囊上任意触摸：续期 2.5s（keepAlive）。 */
  const keepAlive = useCallback(() => {
    if (!capsuleVisible) return;
    scheduleHide();
  }, [capsuleVisible, scheduleHide]);

  // 朝向监听：进横屏给一次性 15s 教学（「工具条在顶缘」）；转回竖屏显隐状态
  // 不跨朝向存活（竖屏底栏常驻自然回归，design §5.5 参数表末行）。
  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const onChange = () => {
      const nowLandscape = mq.matches;
      setLandscape(nowLandscape);
      clearHide();
      if (!nowLandscape) {
        setCapsuleVisible(false);
        return;
      }
      if (!firstShowDone.current) {
        firstShowDone.current = true;
        setCapsuleVisible(true);
        hideTimer.current = window.setTimeout(
          () => setCapsuleVisible(false),
          CAPSULE_FIRST_SHOW_MS,
        );
      }
    };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      clearHide();
    };
  }, [clearHide]);

  // 键盘开合：打开时暂停隐藏计时，关闭时重新计时。
  // 🔴 只响应键盘状态**变化**：显隐变化（首显/热区唤出）会重跑本 effect，
  // 若不拦截，进横屏的 15s 首显教学会被这里的 2.5s 重排覆盖（实测踩过）。
  const capsuleVisibleRef = useRef(capsuleVisible);
  capsuleVisibleRef.current = capsuleVisible;
  const prevKbRef = useRef(keyboardOpen);
  useEffect(() => {
    if (prevKbRef.current === keyboardOpen) return;
    prevKbRef.current = keyboardOpen;
    if (!capsuleVisibleRef.current) return;
    if (keyboardOpen) {
      clearHide();
    } else {
      scheduleHide();
    }
  }, [keyboardOpen, clearHide, scheduleHide]);

  return { landscape, capsuleVisible, interceptDown, keepAlive };
}
