import { describe, it, expect } from "vitest";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  DEFAULT_EXPORT_QUALITY,
  withExportExt,
  formatBytes,
} from "@/lib/imageFormat";

describe("EXPORT_FORMATS metadata", () => {
  it("covers png/jpeg/webp with correct mime + ext", () => {
    expect(EXPORT_FORMATS.png.mime).toBe("image/png");
    expect(EXPORT_FORMATS.png.ext).toBe("png");
    expect(EXPORT_FORMATS.jpeg.mime).toBe("image/jpeg");
    expect(EXPORT_FORMATS.jpeg.ext).toBe("jpg");
    expect(EXPORT_FORMATS.webp.mime).toBe("image/webp");
    expect(EXPORT_FORMATS.webp.ext).toBe("webp");
  });

  it("marks jpeg/webp lossy, png lossless", () => {
    expect(EXPORT_FORMATS.png.lossy).toBe(false);
    expect(EXPORT_FORMATS.jpeg.lossy).toBe(true);
    expect(EXPORT_FORMATS.webp.lossy).toBe(true);
  });

  it("order lists all three formats", () => {
    expect(EXPORT_FORMAT_ORDER).toEqual(["png", "jpeg", "webp"]);
  });

  it("default quality is sensible", () => {
    expect(DEFAULT_EXPORT_QUALITY).toBeGreaterThan(0);
    expect(DEFAULT_EXPORT_QUALITY).toBeLessThanOrEqual(1);
  });
});

describe("withExportExt", () => {
  it("replaces an existing extension", () => {
    expect(withExportExt("photo.png", "jpeg")).toBe("photo.jpg");
    expect(withExportExt("photo.png", "webp")).toBe("photo.webp");
    expect(withExportExt("photo.jpg", "png")).toBe("photo.png");
  });

  it("appends ext when none present", () => {
    expect(withExportExt("image", "webp")).toBe("image.webp");
  });

  it("only strips the final extension segment", () => {
    expect(withExportExt("my.archive.tar.png", "jpeg")).toBe("my.archive.tar.jpg");
  });

  it("falls back to 'image' for empty base", () => {
    expect(withExportExt(".png", "png")).toBe("image.png");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("formats gigabytes (unified with lib/utils, 2026-09-22)", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  it("zero is a valid size, not 'no data'", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns dash for negative/invalid", () => {
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
