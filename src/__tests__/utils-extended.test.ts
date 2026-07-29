import { describe, it, expect } from "vitest";
import {
  cleanSourceName,
  getSourceIcon,
  truncate,
  relativeTime,
  getLangLabel,
} from "@/lib/utils";
import { resolveSource } from "@/lib/source-mappings";

/** 格式化本地时间为 "YYYY-MM-DD HH:mm:ss"（与 Rust chrono::Local 写入格式一致） */
function fmtLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================
// cleanSourceName
// ============================================================

describe("cleanSourceName", () => {
  it("detects Windows paths as Explorer", () => {
    expect(cleanSourceName("C:\\Windows\\explorer.exe")).toBe("资源管理器");
    expect(cleanSourceName("D:\\Projects\\code")).toBe("资源管理器");
  });

  it("detects DevTools", () => {
    expect(cleanSourceName("DevTools — localhost:1420")).toBe("DevTools");
    expect(cleanSourceName("DevTools")).toBe("DevTools");
  });

  it("detects PastePanda", () => {
    expect(cleanSourceName("PastePanda — 主窗口")).toBe("PastePanda");
  });

  it("extracts app name from window title (after last '—')", () => {
    // 窗口标题 "页面标题 — 应用名"，匹配到 SOURCE_MAP 则返回 displayName
    expect(cleanSourceName("README.md — Visual Studio Code")).toBe("VS Code");
    expect(cleanSourceName("New Tab — Google Chrome")).toBe("Chrome");
  });

  it("truncates names longer than 18 chars", () => {
    const long = "Very Long Application Name That Exceeds Limit";
    const result = cleanSourceName(long);
    expect(result.length).toBeLessThanOrEqual(18);
    expect(result.endsWith("…")).toBe(true);
  });

  it("passes through short normal names", () => {
    expect(cleanSourceName("Chrome")).toBe("Chrome");
    expect(cleanSourceName("Terminal")).toBe("Terminal");
  });
});

// ============================================================
// getSourceIcon
// ============================================================

describe("getSourceIcon", () => {
  it("returns icon for VS Code", () => {
    expect(getSourceIcon("VS Code")).toBe("💻");
    expect(getSourceIcon("code")).toBe("💻");
  });

  it("returns icon for Chrome", () => {
    expect(getSourceIcon("Chrome")).toBe("🌐");
    expect(getSourceIcon("Google Chrome")).toBe("🌐");
  });

  it("returns icon for WeChat", () => {
    expect(getSourceIcon("微信")).toBe("💬");
    expect(getSourceIcon("企业微信")).toBe("💼");
  });

  it("returns icon for Terminal", () => {
    expect(getSourceIcon("Terminal")).toBe("⚡");
    expect(getSourceIcon("PowerShell")).toBe("⚡");
  });

  it("returns default icon for unknown source", () => {
    expect(getSourceIcon("UnknownApp")).toBe("🔍");
    expect(getSourceIcon("")).toBe("🔍");
  });

  it("matches case-insensitively", () => {
    expect(getSourceIcon("chrome")).toBe("🌐");
    expect(getSourceIcon("CHROME")).toBe("🌐");
  });
});

// ============================================================
// truncate 扩展
// ============================================================

describe("truncate — 扩展", () => {
  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("replaces newlines with spaces", () => {
    expect(truncate("line1\nline2\nline3", 50)).toBe("line1 line2 line3");
  });

  it("replaces carriage returns with spaces", () => {
    expect(truncate("hello\rworld", 50)).toBe("hello world");
  });

  it("does not split a surrogate pair (emoji) when truncating", () => {
    // 😀 = U+1F600，在 UTF-16 中是代理对 😀（占 2 个 code unit）
    // "hello" 占 5 个 code unit，emoji 紧随其后位于 index 5-6，
    // 若按 UTF-16 code unit 在 maxLen=6 处朴素 slice，会切在代理对中间，产生孤立代理项
    const text = "hello😀world";
    const result = truncate(text, 6);
    const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(result).not.toMatch(lonelySurrogate);
    expect(result).toBe("hello😀...");
  });
});

// ============================================================
// relativeTime 扩展
// ============================================================

describe("relativeTime — 扩展", () => {
  it("returns hours ago", () => {
    const d = new Date(Date.now() - 3 * 3600 * 1000);
    const date = fmtLocal(d);
    const result = relativeTime(date);
    expect(result).toMatch(/小时前/);
  });

  it('returns "昨天" for yesterday', () => {
    const d = new Date(Date.now() - 25 * 3600 * 1000);
    const date = fmtLocal(d);
    expect(relativeTime(date)).toBe("昨天");
  });

  it("returns weekday format for older dates (>= 7 days)", () => {
    // 8天前：diffDay >= 7，进入月日 周X 格式
    const d = new Date(Date.now() - 8 * 86400000);
    const date = fmtLocal(d);
    const result = relativeTime(date);
    expect(result).toMatch(/月\d+日 周[一二三四五六日]/);
  });
});

// ============================================================
// getLangLabel
// ============================================================

describe("getLangLabel", () => {
  it("returns Chinese label for known languages", () => {
    expect(getLangLabel("python")).toBe("Python");
    expect(getLangLabel("javascript")).toBe("JavaScript");
    expect(getLangLabel("typescript")).toBe("TypeScript");
    expect(getLangLabel("rust")).toBe("Rust");
    expect(getLangLabel("sql")).toBe("SQL");
    expect(getLangLabel("bash")).toBe("Bash");
  });

  it('returns "错误日志" for errorlog', () => {
    expect(getLangLabel("errorlog")).toBe("错误日志");
  });

  it('returns "文本" for unknown', () => {
    expect(getLangLabel("unknown")).toBe("文本");
    expect(getLangLabel("")).toBe("文本");
  });
});
