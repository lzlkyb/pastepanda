import { describe, expect, it } from "vitest";
import { isSessionEscape, shouldSwallowEscape } from "@/lib/rcKeyGuard";

describe("isSessionEscape", () => {
  it("key 为 Escape 时命中", () => {
    expect(isSessionEscape({ key: "Escape", code: "Escape" })).toBe(true);
  });
  it("code 为 Escape 时命中（key 不可靠场景）", () => {
    expect(isSessionEscape({ key: "Esc", code: "Escape" })).toBe(true);
  });
  it("普通字符不命中", () => {
    expect(isSessionEscape({ key: "a", code: "KeyA" })).toBe(false);
  });
});

describe("shouldSwallowEscape", () => {
  it("canControl=false → 不吞", () => {
    expect(shouldSwallowEscape(true, true, false)).toBe(false);
  });
  it("捕获态(kbOn) → 吞", () => {
    expect(shouldSwallowEscape(true, false, true)).toBe(true);
  });
  it("仅指针锁定 → 吞（交给锁定那一级）", () => {
    expect(shouldSwallowEscape(false, true, true)).toBe(true);
  });
  it("两者都无 → 不吞（走结束会话）", () => {
    expect(shouldSwallowEscape(false, false, true)).toBe(false);
  });
});
