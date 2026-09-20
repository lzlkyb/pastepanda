import { describe, expect, it } from "vitest";
import { parseAudioBatch } from "@/lib/api/rc";

/** 按后端 `rc_drain_audio` 的小端布局拼一条批（type 0 = cfg JSON，1 = AAC 帧）。 */
function build(
  items: Array<{ type: 0; json: string } | { type: 1; ptsMs: number; data: number[] }>,
  opts: { magic?: string; countOverride?: number } = {},
): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const payload = it.type === 0 ? enc.encode(it.json) : new Uint8Array(it.data);
    const head = new Uint8Array(13);
    const dv = new DataView(head.buffer);
    dv.setUint8(0, it.type);
    dv.setBigInt64(1, BigInt(it.type === 1 ? it.ptsMs : 0), true);
    dv.setUint32(9, payload.length, true);
    parts.push(head, payload);
  }
  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  const magic = opts.magic ?? "RCA1";
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  dv.setUint32(4, opts.countOverride ?? items.length, true);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out.buffer;
}

const cfgJson = (asc = "EhA=") => JSON.stringify({ sr: 48000, ch: 2, asc, br: 128 });

describe("parseAudioBatch", () => {
  it("识别 cfg 与 AAC 帧，asc 还原为字节", () => {
    const { cfg, items } = parseAudioBatch(
      build([
        { type: 0, json: cfgJson() },
        { type: 1, ptsMs: 0, data: [1, 2, 3] },
        { type: 1, ptsMs: 21, data: [4, 5] },
      ]),
    );
    expect(cfg).toEqual({ sr: 48000, ch: 2, asc: new Uint8Array([0x12, 0x10]), br: 128 });
    expect(items.map((f) => f.ptsMs)).toEqual([0, 21]);
    expect(Array.from(items[0].data)).toEqual([1, 2, 3]);
    expect(Array.from(items[1].data)).toEqual([4, 5]);
  });

  it("空批（只有头）：没有 cfg、没有帧", () => {
    const { cfg, items } = parseAudioBatch(build([]));
    expect(cfg).toBeNull();
    expect(items).toEqual([]);
  });

  it("魔数不对 / 太短 → 空结果，不抛", () => {
    expect(parseAudioBatch(build([], { magic: "XXXX" })).items).toEqual([]);
    expect(parseAudioBatch(new ArrayBuffer(4)).items).toEqual([]);
    // 头部声明了 3 条但一条都没有：截断保护，不能抛
    expect(() => parseAudioBatch(build([], { countOverride: 3 }))).not.toThrow();
    expect(parseAudioBatch(build([], { countOverride: 3 })).items).toEqual([]);
  });

  it("尾部截断：已完整的条目照常返回，坏的那条丢掉", () => {
    const full = new Uint8Array(
      build([
        { type: 1, ptsMs: 5, data: [9, 9] },
        { type: 1, ptsMs: 26, data: [7, 7] },
      ]),
    );
    // 砍掉最后 3 字节 → 第二条的 payload 不全
    const cut = full.slice(0, full.length - 3).buffer;
    const { items } = parseAudioBatch(cut);
    expect(items.map((f) => f.ptsMs)).toEqual([5]);
  });

  it("cfg 的 JSON 坏掉只丢 cfg，帧照常解析", () => {
    const { cfg, items } = parseAudioBatch(
      build([
        { type: 0, json: "{不是 JSON" },
        { type: 1, ptsMs: 0, data: [1] },
      ]),
    );
    expect(cfg).toBeNull();
    expect(items).toHaveLength(1);
  });

  it("每次 drain 都带 cfg：取最后一个（新流覆盖旧流）", () => {
    const { cfg } = parseAudioBatch(
      build([
        { type: 0, json: cfgJson("EhA=") },
        { type: 1, ptsMs: 0, data: [1] },
        { type: 0, json: JSON.stringify({ sr: 44100, ch: 1, asc: "Eog=", br: 96 }) },
      ]),
    );
    expect(cfg).toEqual({ sr: 44100, ch: 1, asc: new Uint8Array([0x12, 0x88]), br: 96 });
  });

  it("零长度 payload 的条目被跳过（不是帧）", () => {
    const { items } = parseAudioBatch(build([{ type: 1, ptsMs: 3, data: [] }]));
    expect(items).toEqual([]);
  });
});
