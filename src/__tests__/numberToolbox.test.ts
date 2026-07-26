import { describe, it, expect } from "vitest";
import {
  parseLeadingNumber, formatGrouped, timestampInfo, baseInfo, bytesInfo,
  groupNumbersInText, stripNumberCommas, truncateNumbersInText,
} from "@/lib/numberToolbox";

describe("parseLeadingNumber", () => {
  it("parses plain integer", () => {
    expect(parseLeadingNumber("12345")).toEqual({ value: 12345, isInteger: true, tokenCount: 1 });
  });

  it("parses decimal", () => {
    expect(parseLeadingNumber("123.456")).toEqual({ value: 123.456, isInteger: false, tokenCount: 1 });
  });

  it("strips thousand separators", () => {
    expect(parseLeadingNumber("1,234,567.89")?.value).toBe(1234567.89);
  });

  it("takes first of multiple tokens and counts them", () => {
    const r = parseLeadingNumber("-42 -100 -0.5");
    expect(r?.value).toBe(-42);
    expect(r?.tokenCount).toBe(3);
  });

  it("parses leading-dot decimal", () => {
    expect(parseLeadingNumber(".5")?.value).toBe(0.5);
  });

  it("returns null for no digits", () => {
    expect(parseLeadingNumber("hello world")).toBeNull();
    expect(parseLeadingNumber("")).toBeNull();
  });
});

describe("formatGrouped", () => {
  it("groups thousands", () => {
    expect(formatGrouped(1784937600)).toBe("1,784,937,600");
  });

  it("keeps small numbers plain", () => {
    expect(formatGrouped(42)).toBe("42");
  });
});

describe("timestampInfo", () => {
  it("detects 10-digit seconds", () => {
    const r = timestampInfo(1784937600);
    expect(r?.unit).toBe("s");
    // ISO 为 UTC，与时区无关
    expect(r?.iso).toBe("2026-07-25T00:00:00Z");
  });

  it("detects 13-digit milliseconds", () => {
    const r = timestampInfo(1784937600000);
    expect(r?.unit).toBe("ms");
    expect(r?.iso).toBe("2026-07-25T00:00:00Z");
  });

  it("rejects out-of-range values", () => {
    expect(timestampInfo(42)).toBeNull();
    expect(timestampInfo(999999999)).toBeNull();
    expect(timestampInfo(5000000000)).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(timestampInfo(1784937600.5)).toBeNull();
  });
});

describe("baseInfo", () => {
  it("converts 42 to hex/oct/bin", () => {
    expect(baseInfo(42)).toEqual({ hex: "0x2A", oct: "0o52", bin: "0b101010" });
  });

  it("converts 1784937600", () => {
    const r = baseInfo(1784937600);
    expect(r?.hex).toBe("0x6A63FC80");
    expect(r?.oct).toBe("0o15230776200");
  });

  it("keeps negative sign", () => {
    expect(baseInfo(-255)?.hex).toBe("-0xFF");
  });

  it("rejects non-integers", () => {
    expect(baseInfo(1.5)).toBeNull();
  });
});

describe("bytesInfo", () => {
  it("picks best unit", () => {
    expect(bytesInfo(1784937600)?.best).toBe("1.66 GB");
  });

  it("formats integer results without decimals", () => {
    expect(bytesInfo(1024)?.best).toBe("1 KB");
    expect(bytesInfo(512)?.best).toBe("512 B");
  });

  it("builds detail from lower units", () => {
    const r = bytesInfo(1784937600);
    expect(r?.detail).toContain("MB");
    expect(r?.detail).toContain("KB");
  });

  it("rejects negative / non-integer", () => {
    expect(bytesInfo(-1)).toBeNull();
    expect(bytesInfo(1.5)).toBeNull();
  });
});

describe("text transforms", () => {
  it("groupNumbersInText groups all tokens", () => {
    expect(groupNumbersInText("1234567 and 890")).toBe("1,234,567 and 890");
  });

  it("stripNumberCommas removes grouping", () => {
    expect(stripNumberCommas("1,234,567.89")).toBe("1234567.89");
  });

  it("truncateNumbersInText truncates decimals", () => {
    expect(truncateNumbersInText("3.7 -2.9")).toBe("3 -2");
  });

  it("leaves non-numeric text untouched", () => {
    expect(groupNumbersInText("hello")).toBe("hello");
  });
});
