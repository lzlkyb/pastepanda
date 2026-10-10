import { describe, expect, it } from "vitest";
import { capturePixelRatio } from "./utils";
describe("capture coordinates across mixed-density Mac screens", () => {
  it("uses canonical canvas density instead of the spanning window backing scale", () => {
    expect(capturePixelRatio(7680, 3840, 1, "MacIntel")).toBe(2);
    expect(capturePixelRatio(3840, 3840, 2, "MacIntel")).toBe(1);
    expect(capturePixelRatio(7680, 3840, 1.25, "Win32")).toBe(1.25);
  });
  it("falls back before geometry loads or if the viewport is invalid", () => {
    expect(capturePixelRatio(undefined, 3840, 2, "MacIntel")).toBe(2);
    expect(capturePixelRatio(3840, 0, 2, "MacIntel")).toBe(2);
  });
});
