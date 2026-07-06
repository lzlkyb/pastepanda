import { describe, it, expect } from "vitest";
import { relativeTime, truncate, detectTextType, cn } from "@/lib/utils";

describe("relativeTime", () => {
  it("returns empty string for empty input", () => {
    expect(relativeTime("")).toBe("");
  });

  it('returns "刚刚" for very recent time', () => {
    // 使用 30 秒前的时间，格式化为本地时间字符串（不含时区后缀）
    const d = new Date(Date.now() - 30 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    expect(relativeTime(date)).toBe("刚刚");
  });

  it("returns minutes ago format", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const result = relativeTime(date);
    expect(result).toMatch(/分钟前/);
  });

  it("handles future date gracefully", () => {
    const d = new Date(Date.now() + 3600 * 1000);
    const date = d.toISOString().replace("T", " ").slice(0, 19);
    expect(() => relativeTime(date)).not.toThrow();
  });
});

describe("truncate", () => {
  it("returns text as-is when short enough", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long text with ellipsis", () => {
    expect(truncate("hello world this is long", 10)).toBe("hello worl...");
  });
});

describe("detectTextType", () => {
  it("detects URLs", () => {
    expect(detectTextType("https://example.com")).toBe("link");
    expect(detectTextType("http://test.org")).toBe("link");
  });

  it("detects emails", () => {
    expect(detectTextType("user@example.com")).toBe("email");
  });

  it("detects phone numbers", () => {
    expect(detectTextType("13800138000")).toBe("phone");
  });

  it("defaults to text", () => {
    expect(detectTextType("hello world")).toBe("text");
  });
});

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("filters falsy values", () => {
    expect(cn("foo", false, undefined, "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    expect(cn("base", true && "active", false && "hidden")).toBe("base active");
  });
});
