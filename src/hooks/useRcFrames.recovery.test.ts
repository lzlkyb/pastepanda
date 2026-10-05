import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRcFrames } from "./useRcFrames";
import { rcSendInput, type RcBinFrame } from "@/lib/api/rc";

const feed = vi.hoisted(() => ({ batches: [] as RcBinFrame[][], faults: [] as boolean[], configureFails: false }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => true }));
vi.mock("@/lib/api/rc", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  rcDrainFrames: vi.fn(async () => new ArrayBuffer(0)),
  parseFrameBatch: vi.fn(() => feed.batches.shift() ?? []),
  rcSendInput: vi.fn(async () => {}),
}));

class Decoder {
  decodeQueueSize = 0;
  constructor(private init: VideoDecoderInit) {}
  configure() { if (feed.configureFails) throw new Error("unsupported codec"); }
  decode(chunk: EncodedVideoChunk) {
    if (feed.faults.shift()) throw new Error("bad reference chain");
    this.init.output({ displayWidth: 960, displayHeight: 540, timestamp: chunk.timestamp, close() {} } as VideoFrame);
  }
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", class { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } });
  vi.mocked(rcSendInput).mockClear();
  feed.batches = []; feed.faults = []; feed.configureFails = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function frames(count: number) {
  feed.batches = Array.from({ length: count }, (_, n) => [{
    codec: "h264", key: true, full: true, rect: null, width: 960, height: 540,
    at_ms: n + 1, cap_ms: 0, enc_ms: 0, data: new Uint8Array([1]),
  }]);
  const canvas = document.createElement("canvas");
  const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
  Object.defineProperty(canvas, "getContext", { value: () => ctx });
  const ref = { current: canvas };
  const hook = renderHook(() => useRcFrames("recovery", ref, { phase: "outbound_active" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  return { ...hook, ctx };
}

describe("持续解码失败的恢复", () => {
  it("配置成功但连续三次解码失败，必须退 JPEG", async () => {
    feed.faults = [true, true, true];
    const hook = await frames(3);
    expect(rcSendInput).toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });

  it("configure 失败后不应再访问已被回调关闭的解码器", async () => {
    feed.configureFails = true;
    const hook = await frames(3);
    expect(console.warn).not.toHaveBeenCalledWith("[rc] 取帧轮次失败", expect.anything());
    expect(rcSendInput).toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });

  it("真正绘制成功才清除连续失败计数", async () => {
    feed.faults = [true, true, false, true, true];
    const hook = await frames(5);
    expect(hook.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(rcSendInput).not.toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });
});
