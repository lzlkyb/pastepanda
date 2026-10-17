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
  configure() {
    if (feed.configureFails) throw new Error("unsupported codec");
  }
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
/**
 * 卸载后必须先放一拍**真实**宏任务再拆环境：useRcFrames 的 tick 是
 * `parseFrameBatch(await rcDrainFrames())`，alive 检查在 parse 之后（useRcFrames.ts:359-360），
 * 所以上一条用例卸载时那一次在途 drain 会在下一个真实宏任务里落地，并把下一条用例的
 * 第一批帧解析后丢掉。慢取数注入把这条跨用例偷帧撑成稳定现象（3 批只剩 2 批进解码器
 * → h264Miss 停在 2 → forceJpeg 永不调用 → 本文件第二条用例随机红）。多推几拍盖不住它。
 */
afterEach(async () => {
  await act(async () => {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

/**
 * 模块顶层（beforeEach 装假计时器之前）抓真实 setTimeout：慢取数注入把
 * `rcDrainFrames` 的返回值推迟一个**真实宏任务**落地，假计时器不推进它、
 * RTL waitFor 在假计时器下也 poll 不动——只能逐拍等内容判据成立（bounded，
 * 不成立即抛，不靠「推进够了虚拟时间」碰运气）。
 */
const realSetTimeout = globalThis.setTimeout;

async function untilContent(label: string, pred: () => boolean) {
  for (let tick = 0; ; tick++) {
    await act(async () => {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(150);
    });
    if (pred()) return;
    if (tick >= 199)
      throw new Error(
        `${label}：200 拍真实宏任务内未落地（取帧/解码链没跑到位）calls=${JSON.stringify(
          vi.mocked(rcSendInput).mock.calls.map((c) => c[0]),
        )} batchesLeft=${feed.batches.length}`,
      );
  }
}

const sentInput = (kind: string, codec?: string) =>
  vi.mocked(rcSendInput).mock.calls.some(
    ([f]) => (f as { kind: string; codec?: string }).kind === kind && (codec === undefined || (f as { codec?: string }).codec === codec),
  );

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
    await untilContent("连续三败后退 JPEG", () => sentInput("set_codec", "jpeg"));
    expect(rcSendInput).toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });

  it("configure 失败后不应再访问已被回调关闭的解码器", async () => {
    feed.configureFails = true;
    const hook = await frames(3);
    await untilContent("configure 失败后退 JPEG", () => sentInput("set_codec", "jpeg"));
    expect(console.warn).not.toHaveBeenCalledWith("[rc] 取帧轮次失败", expect.anything());
    expect(rcSendInput).toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });

  it("真正绘制成功才清除连续失败计数", async () => {
    feed.faults = [true, true, false, true, true];
    const hook = await frames(5);
    await untilContent("第三帧真正绘制上屏", () => hook.ctx.drawImage.mock.calls.length >= 1);
    expect(hook.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(rcSendInput).not.toHaveBeenCalledWith({ kind: "set_codec", codec: "jpeg" });
    hook.unmount();
  });
});
