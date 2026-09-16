import { describe, it, expect } from "vitest";
import { canSubmitPair } from "./rcPairState";

// 死锁判据：没有指纹（previewFp 为 null）时，即便 checked 为真也不该可点。
describe("canSubmitPair", () => {
  it("无指纹 + 已勾选 + 非空 code → false（这正是死锁判据）", () => {
    expect(
      canSubmitPair({ code: "abc123", checked: true, previewFp: null, busy: false }),
    ).toBe(false);
  });

  it("有指纹但没勾选 → false", () => {
    expect(
      canSubmitPair({ code: "abc123", checked: false, previewFp: "abcd", busy: false }),
    ).toBe(false);
  });

  it("code 为空 → false", () => {
    expect(
      canSubmitPair({ code: "", checked: true, previewFp: "abcd", busy: false }),
    ).toBe(false);
  });

  it("code 纯空格 → false", () => {
    expect(
      canSubmitPair({ code: "   ", checked: true, previewFp: "abcd", busy: false }),
    ).toBe(false);
  });

  it("四要件齐备且不忙 → true", () => {
    expect(
      canSubmitPair({ code: "abc123", checked: true, previewFp: "abcd", busy: false }),
    ).toBe(true);
  });

  it("busy: true → false", () => {
    expect(
      canSubmitPair({ code: "abc123", checked: true, previewFp: "abcd", busy: true }),
    ).toBe(false);
  });
});
