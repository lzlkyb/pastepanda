import { afterEach, describe, expect, it, vi } from "vitest";
import { H264Decoder } from "./rcH264";

// reset 的真实语义是回到 unconfigured；模拟状态机以免空 mock 掩盖恢复失败。
class Decoder {
  static instances: Decoder[] = [];
  state = "unconfigured";
  decodeQueueSize = 0;
  configure = vi.fn(() => { this.state = "configured"; });
  reset = vi.fn(() => { this.state = "unconfigured"; this.decodeQueueSize = 0; });
  close = vi.fn(() => { this.state = "closed"; });
  decode = vi.fn(() => {
    if (this.state !== "configured") throw new DOMException("not configured", "InvalidStateError");
  });
  constructor() { Decoder.instances.push(this); }
}

afterEach(() => { vi.unstubAllGlobals(); Decoder.instances = []; });

describe("视频积压后的恢复", () => {
  it("丢弃积压后必须重新配置，再提交恢复关键帧", () => {
    vi.stubGlobal("VideoDecoder", Decoder);
    vi.stubGlobal("EncodedVideoChunk", class { constructor(public init: unknown) {} });
    const onError = vi.fn();
    const decoder = new H264Decoder(vi.fn(), onError);
    decoder.ensureConfigured(960, 540, 10);
    decoder.decode(new Uint8Array([1]), true, 1);
    decoder.dropPending();
    decoder.ensureConfigured(960, 540, 10);
    decoder.decode(new Uint8Array([2]), true, 2);
    expect(onError).not.toHaveBeenCalled();
    expect(Decoder.instances[Decoder.instances.length - 1]?.state).toBe("configured");
    decoder.close();
  });
});
