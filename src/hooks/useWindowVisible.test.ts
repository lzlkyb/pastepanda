/**
 * useWindowVisible 守卫单测（2026-10-01，真机联调「等待对方画面」第二根因）。
 *
 * 钉住的不变量：
 * 1. Android（UA 含 "Android"）：**不碰** tauri 窗口 API，可见性跟随
 *    `document.visibilityState`——tauri 窗口状态在移动端恒 false 且事件不来，
 *    按它门控会把帧泵/轮询全饿死（outbox 攒 89 帧没人取的真凶）。
 * 2. 非 Android（桌面 UA）+ 无 tauri 环境：维持旧行为——默认可见（catch 兜底）。
 *
 * jsdom 里用 Object.defineProperty 覆写 navigator.userAgent 与
 * document.visibilityState（两者皆为只读 getter）。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowVisible } from "./useWindowVisible";

function stub(prop: "userAgent" | "visibilityState", value: string) {
  const target: Navigator | Document =
    prop === "userAgent" ? navigator : document;
  Object.defineProperty(target, prop, { configurable: true, get: () => value });
  return () => {
    delete (target as unknown as Record<string, unknown>)[prop];
  };
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  document.removeEventListener("visibilitychange", () => {});
});

describe("useWindowVisible", () => {
  it("Android：可见性跟随 document.visibilityState，事件驱动切换，不问 tauri", () => {
    const restoreUA = stub("userAgent", "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile");
    const restoreVis = stub("visibilityState", "visible");
    try {
      const { result } = renderHook(() => useWindowVisible());
      expect(result.current).toBe(true);

      act(() => {
        stub("visibilityState", "hidden");
        fireVisibilityChange();
      });
      expect(result.current).toBe(false);

      act(() => {
        stub("visibilityState", "visible");
        fireVisibilityChange();
      });
      expect(result.current).toBe(true);
    } finally {
      restoreUA();
      restoreVis();
    }
  });

  it("Android：初始 hidden（Activity 尚未前台）→ false，不误开泵", () => {
    const restoreUA = stub("userAgent", "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile");
    const restoreVis = stub("visibilityState", "hidden");
    try {
      const { result } = renderHook(() => useWindowVisible());
      expect(result.current).toBe(false);
    } finally {
      restoreUA();
      restoreVis();
    }
  });

  it("桌面 UA + 无 tauri 环境：维持旧行为——默认可见", () => {
    const restoreUA = stub("userAgent", "Mozilla/5.0 (Windows NT 10.0) Chrome/120");
    try {
      const { result } = renderHook(() => useWindowVisible());
      expect(result.current).toBe(true);
    } finally {
      restoreUA();
    }
  });
});
