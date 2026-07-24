import { describe, it, expect } from "vitest";
import {
  parseCsv,
  detectDelimiter,
  csvToMarkdown,
  csvToJson,
  convertDelimiter,
} from "@/lib/csv";
import { detectSecretKind, maskSecretText } from "@/lib/secret";

// ─────────────────────────────────────────────
// CSV 解析器
// ─────────────────────────────────────────────

describe("detectDelimiter", () => {
  it("detects comma delimiter", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("detects tab delimiter", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("defaults to comma for empty input", () => {
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("parseCsv", () => {
  it("parses a valid comma table with header", () => {
    const data = parseCsv("姓名,部门,工号\n张三,研发部,A1024\n李四,产品部,B2048");
    expect(data).not.toBeNull();
    expect(data!.headers).toEqual(["姓名", "部门", "工号"]);
    expect(data!.rows).toEqual([
      ["张三", "研发部", "A1024"],
      ["李四", "产品部", "B2048"],
    ]);
    expect(data!.delimiter).toBe(",");
    expect(data!.columnCount).toBe(3);
    expect(data!.rowCount).toBe(3); // 含表头
  });

  it("parses a valid tab table", () => {
    const data = parseCsv("a\tb\n1\t2\n3\t4");
    expect(data).not.toBeNull();
    expect(data!.delimiter).toBe("\t");
    expect(data!.columnCount).toBe(2);
  });

  it("trims cell whitespace", () => {
    const data = parseCsv("a, b\n 1 , 2 ");
    expect(data!.headers).toEqual(["a", "b"]);
    expect(data!.rows).toEqual([["1", "2"]]);
  });

  it("ignores blank lines", () => {
    const data = parseCsv("a,b\n\n1,2\n\n3,4\n");
    expect(data!.rowCount).toBe(3);
  });

  it("returns null for a single row", () => {
    expect(parseCsv("a,b,c")).toBeNull();
  });

  it("returns null for a single column", () => {
    expect(parseCsv("a\nb\nc")).toBeNull();
  });

  it("returns null when column counts are inconsistent", () => {
    expect(parseCsv("a,b,c\n1,2\n3,4,5")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseCsv("")).toBeNull();
  });
});

describe("csvToMarkdown", () => {
  it("produces a markdown table with separator row", () => {
    const data = parseCsv("a,b\n1,2")!;
    expect(csvToMarkdown(data)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("csvToJson", () => {
  it("maps rows to objects keyed by header", () => {
    const data = parseCsv("name,age\nAlice,30\nBob,25")!;
    const parsed = JSON.parse(csvToJson(data));
    expect(parsed).toEqual([
      { name: "Alice", age: "30" },
      { name: "Bob", age: "25" },
    ]);
  });

  it("fills missing trailing cells with empty string", () => {
    // 手动构造一个 rows 长度不足的结构（解析器会拒绝列数不一致，但转换函数应容错）
    const data = {
      headers: ["a", "b"],
      rows: [["1"]],
      delimiter: "," as const,
      columnCount: 2,
      rowCount: 2,
    };
    const parsed = JSON.parse(csvToJson(data));
    expect(parsed).toEqual([{ a: "1", b: "" }]);
  });
});

describe("convertDelimiter", () => {
  it("converts commas to tabs", () => {
    expect(convertDelimiter("a,b\n1,2", "\t")).toBe("a\tb\n1\t2");
  });

  it("converts tabs to commas", () => {
    expect(convertDelimiter("a\tb\n1\t2", ",")).toBe("a,b\n1,2");
  });

  it("preserves line structure", () => {
    expect(convertDelimiter("a,b\n\nc,d", "\t")).toBe("a\tb\n\nc\td");
  });
});

// ─────────────────────────────────────────────
// 密钥脱敏与类型识别
// ─────────────────────────────────────────────

describe("detectSecretKind", () => {
  it("detects JWT (three segments, >50 chars)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(detectSecretKind(jwt)).toBe("JWT");
  });

  it("detects AWS access key (AKIA, exactly 20 chars)", () => {
    expect(detectSecretKind("AKIAIOSFODNN7EXAMPLE")).toBe("AWS");
  });

  it("rejects AKIA with wrong length", () => {
    expect(detectSecretKind("AKIA123")).toBe("密钥");
  });

  it("detects GitHub token (ghp_ prefix, >30 chars)", () => {
    expect(detectSecretKind("ghp_" + "a".repeat(36))).toBe("GitHub");
  });

  it("detects GitHub fine-grained PAT (github_pat_ prefix)", () => {
    expect(detectSecretKind("github_pat_" + "a".repeat(30))).toBe("GitHub");
  });

  it("detects generic Base64 (>30, multiple of 4, base64 charset)", () => {
    expect(detectSecretKind("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")).toBe("Base64");
  });

  it("falls back to generic 密钥 for unrecognized", () => {
    expect(detectSecretKind("short")).toBe("密钥");
  });
});

describe("maskSecretText", () => {
  it("returns short text unchanged", () => {
    expect(maskSecretText("abc")).toBe("abc");
  });

  it("returns text of exactly keep length unchanged", () => {
    expect(maskSecretText("12345678")).toBe("12345678");
  });

  it("masks long text keeping first 8 chars", () => {
    const masked = maskSecretText("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(masked.startsWith("eyJhbGci")).toBe(true);
    expect(masked).toContain("•");
    expect(masked).not.toContain("OiJIUzI1");
  });

  it("caps mask length at 40 for very long secrets", () => {
    const masked = maskSecretText("x".repeat(1000));
    const bulletCount = masked.length - 8;
    expect(bulletCount).toBe(40);
  });

  it("uses at least 12 bullets", () => {
    const masked = maskSecretText("1234567890123"); // 13 chars → ceil(13/4)=4 → clamped to 12
    const bulletCount = masked.length - 8;
    expect(bulletCount).toBe(12);
  });
});
