import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRcAudio } from "./useRcAudio";
const mock = vi.hoisted(() => ({ drain: vi.fn(), consume: vi.fn(), close: vi.fn(), callbacks: [] as ((message: string) => void)[] }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/api/rc", () => ({ rcDrainAudio: mock.drain }));
vi.mock("@/lib/rcAudio", () => ({ RcAudioPlayer: class {
  constructor(onError: (message: string) => void) { mock.callbacks.push(onError); }
  consume = mock.consume; close = mock.close;
} }));
describe("audio polling lifetime", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mock.callbacks.length = 0; mock.drain.mockResolvedValue(new ArrayBuffer(9)); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it("does not poll without a session, starts for an active session, and stops when sound is off", async () => {
    const hook = renderHook(({ id, on }) => useRcAudio(id, on), { initialProps: { id: "", on: true } });
    await act(() => vi.advanceTimersByTimeAsync(120)); expect(mock.drain).not.toHaveBeenCalled();
    hook.rerender({ id: "session", on: true }); await act(() => vi.advanceTimersByTimeAsync(80)); expect(mock.drain).toHaveBeenCalledTimes(2);
    hook.rerender({ id: "session", on: false }); await act(() => vi.advanceTimersByTimeAsync(80)); expect(mock.drain).toHaveBeenCalledTimes(2); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("late decoder errors from a disposed session never reach the new session", () => {
    const report = vi.fn(); const hook = renderHook(({ id }) => useRcAudio(id, true, report), { initialProps: { id: "first" } });
    const old = mock.callbacks[0]; hook.rerender({ id: "second" }); old("old error"); expect(report).not.toHaveBeenCalled();
    mock.callbacks[1]("current error"); expect(report).toHaveBeenCalledWith("current error"); hook.unmount(); mock.callbacks[1]("after close"); expect(report).toHaveBeenCalledTimes(1);
  });
});
