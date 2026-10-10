import { afterEach, describe, expect, it, vi } from "vitest";
import { startRecordingWithWatchdog } from "./recStartGuard";
afterEach(() => vi.useRealTimers());
describe("recording start watchdog", () => {
  it("stops and saves timed-out recording before allowing a retry", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const result = startRecordingWithWatchdog(() => new Promise(() => {}), stop, 100);
    const rejected = expect(result).rejects.toThrow("已请求停止并保存");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the watchdog on success without stopping the active session", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    await startRecordingWithWatchdog(async () => {}, stop, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves ordinary errors without stopping a different session", async () => {
    const stop = vi.fn(async () => {});
    await expect(startRecordingWithWatchdog(async () => { throw new Error("已有录制在进行"); }, stop))
      .rejects.toThrow("已有录制在进行");
    expect(stop).not.toHaveBeenCalled();
  });
});
