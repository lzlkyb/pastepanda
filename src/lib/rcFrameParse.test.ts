import { describe, expect, it } from "vitest";
import { parseFrameBatch } from "@/lib/api/rc";

/** 按后端 `encode_frame_batch` 的小端布局拼一条帧批（RCF2）。 */
function build(
  frames: Array<{
    codec?: 0 | 1 | 2;
    key?: boolean;
    full?: boolean;
    rect?: { x: number; y: number; w: number; h: number } | null;
    atMs?: number;
    capMs?: number;
    encMs?: number;
    width?: number;
    height?: number;
    data: number[];
  }>,
  opts: { magic?: string; countOverride?: number; cut?: number } = {},
): ArrayBuffer {
  const parts: Uint8Array[] = [];
  for (const f of frames) {
    const head = new Uint8Array(44);
    const dv = new DataView(head.buffer);
    dv.setUint8(0, f.codec ?? 0);
    dv.setUint8(1, f.key ? 1 : 0);
    dv.setUint8(2, f.full ? 1 : 0);
    dv.setUint8(3, f.rect ? 1 : 0);
    dv.setBigInt64(4, BigInt(f.atMs ?? 0), true);
    dv.setUint16(12, f.capMs ?? 0, true);
    dv.setUint16(14, f.encMs ?? 0, true);
    dv.setUint32(16, f.width ?? 100, true);
    dv.setUint32(20, f.height ?? 50, true);
    const r = f.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    dv.setUint32(24, r.x, true);
    dv.setUint32(28, r.y, true);
    dv.setUint32(32, r.w, true);
    dv.setUint32(36, r.h, true);
    const payload = new Uint8Array(f.data);
    dv.setUint32(40, payload.length, true);
    parts.push(head, payload);
  }
  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  const magic = opts.magic ?? "RCF2";
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  dv.setUint32(4, opts.countOverride ?? frames.length, true);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  if (opts.cut != null) return out.slice(0, opts.cut).buffer;
  return out.buffer;
}

describe("parseFrameBatch", () => {
  it("识别 jpeg/h264/hevc 与 rect", () => {
    const frames = parseFrameBatch(
      build([
        { codec: 0, key: true, full: true, atMs: 10, data: [1, 2, 3] },
        {
          codec: 1,
          key: false,
          full: false,
          rect: { x: 1, y: 2, w: 3, h: 4 },
          atMs: 21,
          data: [9],
        },
        { codec: 2, key: true, full: true, atMs: 32, data: [7, 7] },
      ]),
    );
    expect(frames.map((f) => f.codec)).toEqual(["jpeg", "h264", "hevc"]);
    expect(frames[0].data).toEqual(new Uint8Array([1, 2, 3]));
    expect(frames[1].rect).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(frames[1].key).toBe(false);
    expect(frames[2].at_ms).toBe(32);
  });

  it("P1-6：前 2 帧完好 + 第 3 帧截断 → 返回 2 帧，不整批吞掉", () => {
    const full = build([
      { atMs: 1, data: [1] },
      { atMs: 2, data: [2] },
      { atMs: 3, data: [3, 3, 3, 3] },
    ]);
    // 砍掉尾部：第 3 帧 payload 不全
    const cut = new Uint8Array(full).slice(0, full.byteLength - 3).buffer;
    const frames = parseFrameBatch(cut);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.at_ms)).toEqual([1, 2]);
  });

  it("P1-6：第 3 帧头都不全时同样保留前 2 帧", () => {
    const full = build([
      { atMs: 1, data: [1] },
      { atMs: 2, data: [2] },
      { atMs: 3, data: [3] },
    ]);
    // 第 3 条 44+1 字节，只留一半头
    const cut = new Uint8Array(full).slice(0, full.byteLength - 25).buffer;
    const frames = parseFrameBatch(cut);
    expect(frames.map((f) => f.at_ms)).toEqual([1, 2]);
  });

  it("magic 头不合法 / 太短 → 返回空数组，不抛", () => {
    expect(parseFrameBatch(build([], { magic: "XXXX" }))).toEqual([]);
    expect(parseFrameBatch(new ArrayBuffer(4))).toEqual([]);
    expect(() => parseFrameBatch(build([{ data: [1] }], { countOverride: 3 }))).not.toThrow();
    // 头部声明 3 条实际只有 1 条：保留那 1 条
    expect(parseFrameBatch(build([{ atMs: 5, data: [1] }], { countOverride: 3 }))).toHaveLength(1);
  });

  it("空批（只有头）→ 空数组", () => {
    expect(parseFrameBatch(build([]))).toEqual([]);
  });
});
