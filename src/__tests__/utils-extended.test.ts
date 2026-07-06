import { describe, it, expect } from "vitest";
import {
  cleanSourceName,
  getSourceIcon,
  truncate,
  detectTextType,
  relativeTime,
  getLangLabel,
} from "@/lib/utils";

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

  it("truncates long names after last dash separator", () => {
    // cleanSourceName 使用 lastIndexOf(" — ")，所以只截掉最后一个 — 之后的内容
    expect(cleanSourceName("VS Code — main.ts — my-project")).toBe("VS Code — main.ts");
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
    expect(getSourceIcon("企业微信")).toBe("💬");
  });

  it("returns icon for Terminal", () => {
    expect(getSourceIcon("Terminal")).toBe("⚡");
    expect(getSourceIcon("PowerShell")).toBe("⚡");
  });

  it("returns undefined for unknown source", () => {
    expect(getSourceIcon("UnknownApp")).toBeUndefined();
    expect(getSourceIcon("")).toBeUndefined();
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
});

// ============================================================
// detectTextType 扩展
// ============================================================

describe("detectTextType — 扩展", () => {
  it("detects file paths", () => {
    expect(detectTextType("C:\\path\\to\\file.txt")).toBe("file");
    expect(detectTextType("/home/user/file.txt")).toBe("file");
    expect(detectTextType("./relative/path")).toBe("file");
  });

  it("detects JSON", () => {
    expect(detectTextType('{"key": "value"}')).toBe("code");
  });

  it("detects HTML", () => {
    expect(detectTextType("<div>hello</div>")).toBe("code");
  });

  it("detects code patterns", () => {
    expect(detectTextType("import React from 'react'")).toBe("code");
    expect(detectTextType("const x = 42")).toBe("code");
    expect(detectTextType("function hello() {}")).toBe("code");
  });

  it("detects git commands", () => {
    expect(detectTextType("git commit -m 'fix'")).toBe("code");
  });

  it("handles empty input", () => {
    expect(detectTextType("")).toBe("text");
  });

  it("detects error logs", () => {
    expect(detectTextType("2024-01-01 12:00:00 ERROR Connection failed")).toBe("code");
  });
});

// ============================================================
// relativeTime 扩展
// ============================================================

describe("relativeTime — 扩展", () => {
  it("returns hours ago", () => {
    const d = new Date(Date.now() - 3 * 3600 * 1000);
    const date = d.toISOString().replace("T", " ").slice(0, 19);
    const result = relativeTime(date);
    expect(result).toMatch(/小时前/);
  });

  it('returns "昨天" for yesterday', () => {
    const d = new Date(Date.now() - 25 * 3600 * 1000);
    const date = d.toISOString().replace("T", " ").slice(0, 19);
    expect(relativeTime(date)).toBe("昨天");
  });

  it("returns weekday format for older dates (>= 7 days)", () => {
    // 8天前：diffDay >= 7，进入月日 周X 格式
    const d = new Date(Date.now() - 8 * 86400000);
    const date = d.toISOString().replace("T", " ").slice(0, 19);
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
