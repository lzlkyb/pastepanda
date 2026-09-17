import { describe, expect, it } from "vitest";
import { webcodecsCodecFor } from "@/lib/rcH264";

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
});
