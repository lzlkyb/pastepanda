import { afterEach, describe, expect, it, vi } from "vitest";
import { createJpegSink } from "./rcJpegSink";
import type { RcBinFrame } from "./api/rcFrameTypes";

afterEach(() => vi.unstubAllGlobals());

describe("JPEG 实际上屏反馈", () => {
  const frame: RcBinFrame = { codec: "jpeg", key: true, full: true, at_ms: 1234,
    cap_ms: 0, enc_ms: 0, width: 800, height: 600, rect: null, data: new Uint8Array([1]) };
  const setup = (alive = true) => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 600, close })));
    const shown = vi.fn();
    const key = vi.fn();
    const canvas = document.createElement("canvas");
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    const sink = createJpegSink({ alive: () => alive, content: { current: { w: 0, h: 0 } },
      setSize: vi.fn(), onShown: shown, requestKey: key });
    return { sink, shown, key, canvas, ctx, close };
  };

  it("绘制完成才报告该帧时间戳，并释放位图", async () => {
    const x = setup();
    await x.sink(frame, x.canvas, x.ctx);
    expect(x.ctx.drawImage).toHaveBeenCalledOnce();
    expect(x.shown).toHaveBeenCalledWith(1234);
    expect(x.close).toHaveBeenCalledOnce();
  });

  it("脏块缺少参考画布时请求关键帧，不谎报上屏", async () => {
    const x = setup();
    await x.sink({ ...frame, full: false, rect: { x: 1, y: 1, w: 10, h: 10 } }, x.canvas, x.ctx);
    expect(x.key).toHaveBeenCalledOnce();
    expect(x.shown).not.toHaveBeenCalled();
  });

  it("会话卸载后不报告旧帧", async () => {
    const x = setup(false);
    await x.sink(frame, x.canvas, x.ctx);
    expect(x.shown).not.toHaveBeenCalled();
    expect(x.close).toHaveBeenCalledOnce();
  });
});
