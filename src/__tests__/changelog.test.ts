import { describe, it, expect } from "vitest";
import { compareVersions, isVersioned } from "@/lib/changelog";

describe("compareVersions", () => {
  it("正常 semver 比较", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("非 semver（如 [Unreleased]）视为最低，且自身相等", () => {
    // [Unreleased] 永远小于真实版本
    expect(compareVersions("[Unreleased]", "6.20.0")).toBe(-1);
    expect(compareVersions("6.20.0", "[Unreleased]")).toBe(1);
    // 两个 [Unreleased] 相等
    expect(compareVersions("[Unreleased]", "[Unreleased]")).toBe(0);
    // 空串/脏数据也安全
    expect(compareVersions("", "1.0.0")).toBe(-1);
  });
});

describe("isVersioned", () => {
  it("只接受 x.y.z", () => {
    expect(isVersioned("1.2.3")).toBe(true);
    expect(isVersioned("0.1.0")).toBe(true);
    expect(isVersioned("[Unreleased]")).toBe(false);
    expect(isVersioned("1.2")).toBe(false);
    expect(isVersioned("v1.2.3")).toBe(false);
    expect(isVersioned(null)).toBe(false);
    expect(isVersioned(undefined)).toBe(false);
  });
});
