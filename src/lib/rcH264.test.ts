import { describe, expect, it } from "vitest";
import { webcodecsCodecFor, webcodecsHevcFor } from "@/lib/rcH264";

describe("webcodecsCodecFor", () => {
  it("1080p 用 High@4.2", () => {
    expect(webcodecsCodecFor(1920, 1080)).toBe("avc1.64002a");
  });
  it("4K 用 High@5.1", () => {
    expect(webcodecsCodecFor(3840, 2160)).toBe("avc1.640033");
  });
  it("720p 用 High@4.0", () => {
    expect(webcodecsCodecFor(1280, 720)).toBe("avc1.640028");
  });
  it("D4：fps>60 抬到 5.1——1080p120 超出 L4.2 宏块率规格", () => {
    expect(webcodecsCodecFor(1920, 1080, 120)).toBe("avc1.640033");
    expect(webcodecsCodecFor(1920, 1080, 60)).toBe("avc1.64002a");
  });
  it("Q4：4K60 连 L5.1 都超规格（32400MB/帧 × 60 ≈ 194 万 MB/s），必须 L5.2", () => {
    expect(webcodecsCodecFor(3840, 2160, 60)).toBe("avc1.640034");
    // 4K30 仍是 L5.1
    expect(webcodecsCodecFor(3840, 2160, 30)).toBe("avc1.640033");
  });
});

describe("webcodecsHevcFor（Q3）", () => {
  it("level 按 luma 采样率取最小覆盖档（2026-09-19 审查修复）", () => {
    // fps 未指定按 60 兜最坏：1080p60=124M 超 L4.0 的 66.7M，落 L4.1
    expect(webcodecsHevcFor(1920, 1080)).toBe("hev1.1.6.L123.B0");
    // 1440p60=221M → L5.0
    expect(webcodecsHevcFor(2560, 1440)).toBe("hev1.1.6.L150.B0");
    // 4K60=498M → L5.1
    expect(webcodecsHevcFor(3840, 2160)).toBe("hev1.1.6.L153.B0");
  });
  it("明确帧率时精确取档：1080p30 落 L4.0、1080p120 落 L5.0、4K120 落 L5.2", () => {
    expect(webcodecsHevcFor(1920, 1080, 30)).toBe("hev1.1.6.L120.B0");
    expect(webcodecsHevcFor(1920, 1080, 120)).toBe("hev1.1.6.L150.B0");
    expect(webcodecsHevcFor(3840, 2160, 120)).toBe("hev1.1.6.L156.B0");
  });
});
