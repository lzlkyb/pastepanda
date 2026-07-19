import { describe, it, expect } from "vitest";
import { detectColor, toHex, toRgb, toHsl } from "@/lib/color";

describe("detectColor", () => {
  it("detects 6-digit hex", () => {
    expect(detectColor("#FF5733")).toEqual({ r: 255, g: 87, b: 51, a: 1, format: "hex" });
  });

  it("detects 3-digit hex and expands it", () => {
    expect(detectColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1, format: "hex" });
  });

  it("detects 8-digit hex with alpha", () => {
    // ff = alpha 255/255 = 1, 80 = 128/255 ≈ 0.502
    const result = detectColor("#3B82F680");
    expect(result?.r).toBe(59);
    expect(result?.g).toBe(130);
    expect(result?.b).toBe(246);
    expect(result?.a).toBeCloseTo(0.502, 2);
  });

  it("detects 4-digit hex with alpha and expands it", () => {
    const result = detectColor("#0f08");
    expect(result?.r).toBe(0);
    expect(result?.g).toBe(255);
    expect(result?.b).toBe(0);
    expect(result?.a).toBeCloseTo(0.533, 2);
  });

  it("detects rgb()", () => {
    expect(detectColor("rgb(255, 87, 51)")).toEqual({ r: 255, g: 87, b: 51, a: 1, format: "rgb" });
  });

  it("detects rgba() with decimal alpha", () => {
    expect(detectColor("rgba(59, 130, 246, 0.5)")).toEqual({ r: 59, g: 130, b: 246, a: 0.5, format: "rgb" });
  });

  it("detects hsl()", () => {
    const result = detectColor("hsl(9, 100%, 60%)");
    expect(result).not.toBeNull();
    expect(result!.a).toBe(1);
    // hsl(9,100%,60%) ≈ rgb(255, 89, 51)
    expect(result!.r).toBeGreaterThan(240);
    expect(result!.g).toBeGreaterThan(70);
    expect(result!.g).toBeLessThan(110);
    expect(result!.b).toBeLessThan(70);
  });

  it("detects hsla() with alpha", () => {
    const result = detectColor("hsla(160, 84%, 39%, 0.6)");
    expect(result?.a).toBe(0.6);
  });

  it("is case-insensitive and tolerates internal whitespace", () => {
    expect(detectColor("#FF5733")).toEqual(detectColor("#ff5733"));
    expect(detectColor("RGB( 255 , 87 , 51 )")).toEqual({ r: 255, g: 87, b: 51, a: 1, format: "rgb" });
  });

  it("rejects rgb() with out-of-range components", () => {
    expect(detectColor("rgb(300, 0, 0)")).toBeNull();
  });

  it("rejects hsl() with out-of-range percentages", () => {
    expect(detectColor("hsl(0, 150%, 50%)")).toBeNull();
  });

  it("rejects invalid hex length", () => {
    expect(detectColor("#FF")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(detectColor("hello world")).toBeNull();
  });

  it("returns null for code containing a color substring", () => {
    expect(detectColor("body { color: #FF5733; }")).toBeNull();
  });

  it("returns null for a bare CSS named color", () => {
    expect(detectColor("red")).toBeNull();
    expect(detectColor("dodgerblue")).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(detectColor("")).toBeNull();
    expect(detectColor("   ")).toBeNull();
  });
});

describe("toHex / toRgb / toHsl", () => {
  it("toHex renders opaque color without alpha suffix", () => {
    expect(toHex({ r: 255, g: 87, b: 51, a: 1, format: "hex" })).toBe("#ff5733");
  });

  it("toHex renders alpha suffix when a < 1", () => {
    expect(toHex({ r: 59, g: 130, b: 246, a: 0.5, format: "hex" })).toBe("#3b82f680");
  });

  it("toRgb renders rgb() when opaque, rgba() when transparent", () => {
    expect(toRgb({ r: 255, g: 87, b: 51, a: 1, format: "rgb" })).toBe("rgb(255, 87, 51)");
    expect(toRgb({ r: 255, g: 87, b: 51, a: 0.5, format: "rgb" })).toBe("rgba(255, 87, 51, 0.5)");
  });

  it("toHsl renders hsl() when opaque, hsla() when transparent", () => {
    expect(toHsl({ r: 255, g: 87, b: 51, a: 1, format: "hsl" })).toBe("hsl(11, 100%, 60%)");
    expect(toHsl({ r: 255, g: 87, b: 51, a: 0.5, format: "hsl" })).toBe("hsla(11, 100%, 60%, 0.5)");
  });

  it("rounds alpha derived from 8-digit hex to 2 decimal places in toRgb/toHsl", () => {
    const parsed = detectColor("#3B82F680")!;
    expect(toRgb(parsed)).toBe("rgba(59, 130, 246, 0.5)");
    expect(toHsl(parsed)).toBe("hsla(217, 91%, 60%, 0.5)");
  });

  it("round-trips hex -> parsed -> hex", () => {
    const parsed = detectColor("#3B82F6")!;
    expect(toHex(parsed)).toBe("#3b82f6");
  });

  it("round-trips rgb -> hsl -> rgb within rounding tolerance", () => {
    const parsed = detectColor("rgb(59, 130, 246)")!;
    const hslStr = toHsl(parsed);
    const reparsed = detectColor(hslStr)!;
    expect(Math.abs(reparsed.r - parsed.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(reparsed.g - parsed.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(reparsed.b - parsed.b)).toBeLessThanOrEqual(2);
  });
});
