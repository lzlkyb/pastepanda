// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRcFrames } from "./useRcFrames";
import { rcDrainFrames, rcSendInput, type RcBinFrame } from "@/lib/api/rc";
const feed = vi.hoisted(() => ({ batches: [] as RcBinFrame[][], visible: true }));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => feed.visible }));
vi.mock("@/lib/api/rc", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  rcDrainFrames: vi.fn(async () => new ArrayBuffer(0)),
  parseFrameBatch: vi.fn(() => feed.batches.shift() ?? []),
  rcSendInput: vi.fn(async () => {}),
}));
beforeEach(() => {
  vi.useFakeTimers(); feed.batches = []; feed.visible = true;
  vi.stubGlobal("VideoDecoder", undefined);
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  vi.mocked(rcDrainFrames).mockClear(); vi.mocked(rcSendInput).mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount() {
  const ctx = { putImageData: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() };
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", { value: () => ctx });
  const ref = { current: canvas };
  const hook = renderHook(() => useRcFrames("owned-native-session", ref));
  return { ...hook, ctx, canvas };
}
describe("没有 WebCodecs AV1 的原生接收", () => {
  it("画面确实上屏、保留会话进度和 AV1 标签，不触发 AVC 回退", async () => {
    feed.batches = [[{
      native: { wireBytes: 800, decodeMs: 1.5 }, codec: "av1", key: true, full: true,
      width: 2, height: 2, rect: null, at_ms: 123, cap_ms: 0, enc_ms: 0,
      data: new Uint8Array(16).fill(120),
    }]];
    const h = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.ctx.putImageData).toHaveBeenCalledOnce();
    const picture = h.ctx.putImageData.mock.calls[0][0] as ImageData;
    expect(picture.data).toEqual(new Uint8ClampedArray(16).fill(120));
    expect(h.result.current.hasFrame).toBe(true);
    expect(h.result.current.codec).toBe("av1");
    expect(h.canvas.width).toBe(2);
    expect(rcDrainFrames).toHaveBeenCalledWith("owned-native-session");
    expect(rcSendInput).not.toHaveBeenCalledWith({ kind: "set_codec", codec: "h264" });
    h.unmount();
  });
  it("请求 AVC 回退不能提前宣称已经收到 H.264 帧", async () => {
    const f: RcBinFrame = { codec: "av1", key: true, full: true, width: 2, height: 2,
      rect: null, at_ms: 100, cap_ms: 0, enc_ms: 0, data: new Uint8Array([1, 2]) };
    feed.batches = [[f, f, f]];
    const h = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(rcSendInput).toHaveBeenCalledWith({ kind: "set_codec", codec: "h264" });
    expect(h.result.current.codec).toBe("av1");
    h.unmount();
  });
  it("窗口隐藏时不取帧，卸载后不持续调用原生解码", async () => {
    feed.visible = false;
    const h = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(rcDrainFrames).not.toHaveBeenCalled();
    h.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(rcDrainFrames).not.toHaveBeenCalled();
  });
});
