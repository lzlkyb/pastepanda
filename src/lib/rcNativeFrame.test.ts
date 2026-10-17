import { describe, expect, it } from "vitest";
import { parseFrameBatch } from "./api/rcFrameParse";

function nativeFrame(width = 2, height = 2, payload = 24, codec = 0x83) {
  const buffer = new ArrayBuffer(52 + payload);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x52, 0x43, 0x46, 0x32]);
  const view = new DataView(buffer);
  view.setUint32(4, 1, true);
  bytes[8] = codec;
  bytes[9] = bytes[10] = 1;
  view.setBigInt64(12, 123n, true);
  view.setUint32(24, width, true);
  view.setUint32(28, height, true);
  view.setUint32(48, payload, true);
  if (payload >= 8) {
    view.setUint32(52, 800, true);
    view.setUint32(56, 1500, true);
    bytes.fill(120, 60);
  }
  return buffer;
}

describe("原生 AV1 的二进制画面边界", () => {
  it("保留 AV1 标签、原始带宽和实测解码耗时，像素不经过 JSON", () => {
    const buffer = nativeFrame();
    const [frame] = parseFrameBatch(buffer);
    expect(frame.codec).toBe("av1");
    expect(frame.native).toEqual({ wireBytes: 800, decodeMs: 1.5 });
    expect(frame.data.byteLength).toBe(16);
    expect(frame.data.buffer).toBe(buffer);
    expect(frame.at_ms).toBe(123);
  });
  it.each([[2, 2, 23], [0, 2, 8], [3840, 2160, 8], [2, 2, 7]])(
    "拒绝尺寸或像素长度不一致 (%i×%i, %i bytes)", (w, h, size) => {
      expect(parseFrameBatch(nativeFrame(w, h, size))).toEqual([]);
    },
  );
  it("未知 codec 不得被当成 JPEG", () => {
    expect(parseFrameBatch(nativeFrame(2, 2, 24, 0x81))).toEqual([]);
  });
});
