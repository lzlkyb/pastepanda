import { describe, it, expect } from "vitest";
import { deviceAvatarStyle, relTime, DEFAULT_RC_DEVICE_NAME } from "@/lib/rcDevice";

describe("deviceAvatarStyle (D1/C10)", () => {
  it("任意不同 node_id 得到同一颜色（一屏一强调色，不再随机）", () => {
    const a = deviceAvatarStyle("node-A");
    const b = deviceAvatarStyle("node-B");
    const c = deviceAvatarStyle("completely-different-id");
    expect(a.background).toBe(b.background);
    expect(b.background).toBe(c.background);
    expect(a.color).toBe(b.color);
  });

  it("背景/文字都不含随机 hsl(", () => {
    const s = deviceAvatarStyle("any-id");
    expect(s.background).not.toContain("hsl(");
    expect(s.color).not.toContain("hsl(");
  });

  it("基于语义 token 派生、文字为深色（对比度达标不变量）", () => {
    const s = deviceAvatarStyle("any-id");
    expect(s.background).toContain("color-mix");
    expect(s.background).toContain("var(--accent");
    expect(s.color).toContain("var(--text-primary");
  });
});

describe("relTime (D4)", () => {
  const NOW = 1_700_000_000_000;

  it("null / undefined / 0 → 空串（调用方据此不显示空文案）", () => {
    expect(relTime(null, NOW)).toBe("");
    expect(relTime(undefined, NOW)).toBe("");
    expect(relTime(0, NOW)).toBe("");
  });

  it("未来时间 → 刚刚（边界不崩）", () => {
    expect(relTime(NOW + 10_000, NOW)).toBe("刚刚");
  });

  it("刚发生（<60s）→ 刚刚", () => {
    expect(relTime(NOW - 30_000, NOW)).toBe("刚刚");
  });

  it("分钟级", () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
  });

  it("小时级", () => {
    expect(relTime(NOW - 2 * 3_600_000, NOW)).toBe("2 小时前");
  });

  it("天级", () => {
    expect(relTime(NOW - 3 * 86_400_000, NOW)).toBe("3 天前");
  });

  it("默认 now 取 Date.now() 不抛错", () => {
    expect(typeof relTime(Date.now() - 1000)).toBe("string");
  });
});

describe("DEFAULT_RC_DEVICE_NAME (C4)", () => {
  it("非空常量，供两处统一来源", () => {
    expect(DEFAULT_RC_DEVICE_NAME.length).toBeGreaterThan(0);
  });
});
