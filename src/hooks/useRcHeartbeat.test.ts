/**
 * useRcHeartbeat 守卫单测（2026-10-01 真机联调故障的回归钉）。
 *
 * 故障原貌：手机会话壳没发心跳 → 被控端 3.5s 停推帧（画面永远等不到）、
 * 15s 看门狗判「对端失联」强制结束会话。这条测试钉住心跳 hook 的三件事：
 * ① 会话内每秒发一枚 ping（ts 为 epoch，跨进程算 RTT 用）；
 * ② sessionId 为空（沙盒 / 未进会话）零 ping——不给无人收听的空转留口子；
 * ③ 会话切换 / 卸载清干净计时器，旧会话的 ping 不外泄。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RC_PING_MS, useRcHeartbeat } from "./useRcHeartbeat";
import { rcSendInput } from "@/lib/api/rc";

vi.mock("@/lib/api/rc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rcSendInput: vi.fn(async () => undefined),
}));

const send = vi.mocked(rcSendInput);

beforeEach(() => {
  send.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRcHeartbeat", () => {
  it("会话内每秒发一枚 ping，ts 为当前 epoch", () => {
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    renderHook(() => useRcHeartbeat("s1"));

    act(() => { vi.advanceTimersByTime(RC_PING_MS); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ kind: "ping", ts: t0 + RC_PING_MS });

    act(() => { vi.advanceTimersByTime(RC_PING_MS * 2); });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("sessionId 为空：零 ping（沙盒不空转）", () => {
    renderHook(() => useRcHeartbeat(""));
    act(() => { vi.advanceTimersByTime(RC_PING_MS * 5); });
    expect(send).not.toHaveBeenCalled();
  });

  it("会话切换后旧计时器清干净：切到空会话不再发", () => {
    const { rerender } = renderHook(({ id }) => useRcHeartbeat(id), {
      initialProps: { id: "s1" },
    });
    act(() => { vi.advanceTimersByTime(RC_PING_MS); });
    expect(send).toHaveBeenCalledTimes(1);

    rerender({ id: "" });
    act(() => { vi.advanceTimersByTime(RC_PING_MS * 3); });
    expect(send).toHaveBeenCalledTimes(1);

    rerender({ id: "s2" });
    act(() => { vi.advanceTimersByTime(RC_PING_MS); });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
