/**
 * useRcBackgroundPause 守卫测试——钉住后台保活（2026-10-02）的发射纪律：
 *
 * ① hidden → 恰好一条 bg_pause；visible → 恰好一条 bg_resume。发错方向或
 *    多发，被控端的推流挂起/看门狗放宽就跟着错；
 * ② sessionId 为空（沙盒/未进会话）不订阅 visibilitychange——没有会话就
 *    没有收件人，空转通知是对端日志里的噪音；
 * ③ 发送失败静默（生命周期通知不是用户动作，不允许弹任何提示）。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rcSendInput: vi.fn(async () => {}) }));
vi.mock("@/lib/api/rc", () => ({ rcSendInput: api.rcSendInput }));

import { useRcBackgroundPause } from "./useRcBackgroundPause";

function fireVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => api.rcSendInput.mockClear().mockResolvedValue(undefined));
afterEach(() => vi.restoreAllMocks());

describe("useRcBackgroundPause", () => {
  it("进后台恰好一条 bg_pause，回前台恰好一条 bg_resume", () => {
    renderHook(() => useRcBackgroundPause("s1"));
    act(() => fireVisibility("hidden"));
    expect(api.rcSendInput).toHaveBeenCalledTimes(1);
    expect(api.rcSendInput).toHaveBeenCalledWith({ kind: "bg_pause" });
    act(() => fireVisibility("visible"));
    expect(api.rcSendInput).toHaveBeenCalledTimes(2);
    expect(api.rcSendInput).toHaveBeenLastCalledWith({ kind: "bg_resume" });
  });

  it("sessionId 为空不订阅也不发送", () => {
    renderHook(() => useRcBackgroundPause(""));
    act(() => fireVisibility("hidden"));
    expect(api.rcSendInput).not.toHaveBeenCalled();
  });

  it("卸载后不再响应 visibilitychange", () => {
    const { unmount } = renderHook(() => useRcBackgroundPause("s1"));
    unmount();
    act(() => fireVisibility("hidden"));
    expect(api.rcSendInput).not.toHaveBeenCalled();
  });

  it("发送失败静默（catch 掉，不冒 unhandled rejection）", async () => {
    api.rcSendInput.mockRejectedValueOnce(new Error("会话已结束"));
    renderHook(() => useRcBackgroundPause("s1"));
    act(() => fireVisibility("hidden"));
    await Promise.resolve();
    expect(api.rcSendInput).toHaveBeenCalledTimes(1);
  });
});
