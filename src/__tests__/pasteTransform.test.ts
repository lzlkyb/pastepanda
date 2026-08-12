import { describe, it, expect } from "vitest";
import { applyPasteTransform } from "@/lib/pasteTransform";
// parseFilePaths 已收口到 lib/utils（原来 pasteTransform / Card 各一份、行为不一致）
import { parseFilePaths } from "@/lib/utils";

// ============================================================
// 文本通用变换
// ============================================================
describe("文本通用变换", () => {
  it("upper: 全部大写", () => {
    expect(applyPasteTransform({ text: "Hello World", content: "" }, "upper")).toBe("HELLO WORLD");
  });

  it("lower: 全部小写", () => {
    expect(applyPasteTransform({ text: "Hello World", content: "" }, "lower")).toBe("hello world");
  });

  it("strip: 去除首尾空白", () => {
    expect(applyPasteTransform({ text: "  hello  \n", content: "" }, "strip")).toBe("hello");
  });

  it("strip_lines: 去除空行", () => {
    expect(applyPasteTransform({ text: "a\n\nb\n\n\nc", content: "" }, "strip_lines")).toBe("a\nb\nc");
  });

  it("strip_lines: 保留含空格的行（trim 后非空）", () => {
    expect(applyPasteTransform({ text: "a\n   \nb", content: "" }, "strip_lines")).toBe("a\nb");
  });

  it("quote: 添加双引号", () => {
    expect(applyPasteTransform({ text: "hello", content: "" }, "quote")).toBe('"hello"');
  });

  it("md_link: 生成 Markdown 链接（标题截断 30 字符）", () => {
    const url = "https://example.com/very/long/path/that/exceeds/thirty/characters";
    const result = applyPasteTransform({ text: url, content: "" }, "md_link");
    expect(result).toBe(`[${url.slice(0, 30)}](${url})`);
  });

  it("md_link: 短 URL 不截断", () => {
    const url = "https://a.co";
    expect(applyPasteTransform({ text: url, content: "" }, "md_link")).toBe(`[${url}](${url})`);
  });

  it("strip_html: 去除 HTML 标签", () => {
    expect(applyPasteTransform({ text: "<p>hello</p><br/><b>world</b>", content: "" }, "strip_html")).toBe("helloworld");
  });
});

// ============================================================
// 链接 / 邮箱
// ============================================================
describe("链接/邮箱变换", () => {
  it("plain_url: 提取 hostname + pathname", () => {
    expect(applyPasteTransform({ text: "https://github.com/user/repo?q=1", content: "" }, "plain_url"))
      .toBe("github.com/user/repo");
  });

  it("plain_url: 无效 URL 保持原文", () => {
    expect(applyPasteTransform({ text: "not a url", content: "" }, "plain_url")).toBe("not a url");
  });

  it("mailto: 添加 mailto: 前缀", () => {
    expect(applyPasteTransform({ text: " user@example.com ", content: "" }, "mailto")).toBe("mailto:user@example.com");
  });
});

// ============================================================
// 代码
// ============================================================
describe("代码变换", () => {
  it("code_block: 包裹 ``` 围栏", () => {
    expect(applyPasteTransform({ text: "const x = 1;", content: "" }, "code_block")).toBe("```\nconst x = 1;\n```");
  });

  it("single_line: 多行合并为单行（分号分隔）", () => {
    expect(applyPasteTransform({ text: "  a\n  b\n  c  ", content: "" }, "single_line")).toBe("a; b; c");
  });
});

// ============================================================
// 电话
// ============================================================
describe("电话变换", () => {
  it("tel: 添加 tel: 前缀并去除分隔符", () => {
    expect(applyPasteTransform({ text: "138-1234-5678", content: "" }, "tel")).toBe("tel:13812345678");
  });

  it("phone_cn: 无 86 前缀时添加 +86", () => {
    expect(applyPasteTransform({ text: "13812345678", content: "" }, "phone_cn")).toBe("+8613812345678");
  });

  it("phone_cn: 已有 86 前缀时只加 +", () => {
    expect(applyPasteTransform({ text: "8613812345678", content: "" }, "phone_cn")).toBe("+8613812345678");
  });

  it("phone_cn: 去除括号和空格", () => {
    expect(applyPasteTransform({ text: "(+86) 138 1234 5678", content: "" }, "phone_cn")).toBe("+8613812345678");
  });
});

// ============================================================
// 颜色
// ============================================================
describe("颜色变换", () => {
  it("color_hex: 解析 rgb 转 hex", () => {
    const result = applyPasteTransform({ text: "rgb(255, 0, 0)", content: "" }, "color_hex");
    expect(result).toBe("#ff0000");
  });

  it("color_rgb: 解析 hex 转 rgb", () => {
    const result = applyPasteTransform({ text: "#ff0000", content: "" }, "color_rgb");
    expect(result).toContain("rgb");
    expect(result).toContain("255");
  });

  it("color_hsl: 解析 hex 转 hsl", () => {
    const result = applyPasteTransform({ text: "#ff0000", content: "" }, "color_hsl");
    expect(result).toContain("hsl");
  });

  it("color_hex: 无法解析时保持原文", () => {
    expect(applyPasteTransform({ text: "not-a-color", content: "" }, "color_hex")).toBe("not-a-color");
  });
});

// ============================================================
// 图片
// ============================================================
describe("图片变换", () => {
  it("md_image: 使用 content 路径", () => {
    expect(applyPasteTransform({ text: "[图片]", content: "C:\\img.png" }, "md_image")).toBe("![图片](C:\\img.png)");
  });

  it("md_image: content 为空时用 text", () => {
    expect(applyPasteTransform({ text: "C:\\img.png", content: "" }, "md_image")).toBe("![图片](C:\\img.png)");
  });
});

// ============================================================
// 文件
// ============================================================
describe("文件变换", () => {
  const jsonContent = JSON.stringify(["C:\\Users\\test\\file1.txt", "D:/docs/file2.pdf"]);

  it("file_name: 提取文件名", () => {
    const result = applyPasteTransform({ text: "", content: jsonContent }, "file_name");
    expect(result).toBe("file1.txt\nfile2.pdf");
  });

  it("file_dir: 提取目录", () => {
    const result = applyPasteTransform({ text: "", content: jsonContent }, "file_dir");
    expect(result).toBe("C:\\Users\\test\nD:/docs");
  });

  it("file_bslash: 统一为反斜杠", () => {
    const result = applyPasteTransform({ text: "", content: jsonContent }, "file_bslash");
    expect(result).toBe("C:\\Users\\test\\file1.txt\nD:\\docs\\file2.pdf");
  });

  it("file_fslash: 统一为正斜杠", () => {
    const result = applyPasteTransform({ text: "", content: jsonContent }, "file_fslash");
    expect(result).toBe("C:/Users/test/file1.txt\nD:/docs/file2.pdf");
  });

  it("file_list: 原样列出", () => {
    const result = applyPasteTransform({ text: "", content: jsonContent }, "file_list");
    expect(result).toBe("C:\\Users\\test\\file1.txt\nD:/docs/file2.pdf");
  });

  it("file_name: 单路径（非 JSON）", () => {
    const result = applyPasteTransform({ text: "", content: "C:\\single.txt" }, "file_name");
    expect(result).toBe("single.txt");
  });
});

// ============================================================
// parseFilePaths 辅助函数
// ============================================================
describe("parseFilePaths", () => {
  it("parses JSON array", () => {
    expect(parseFilePaths('["a.txt","b.txt"]')).toEqual(["a.txt", "b.txt"]);
  });

  it("falls back to newline split for non-JSON", () => {
    expect(parseFilePaths("a.txt\nb.txt")).toEqual(["a.txt", "b.txt"]);
  });

  it("returns empty for empty string", () => {
    expect(parseFilePaths("")).toEqual([]);
  });

  it("filters non-string entries from JSON", () => {
    expect(parseFilePaths('[1, "a.txt", null]')).toEqual(["a.txt"]);
  });
});

// ============================================================
// 未知变换
// ============================================================
describe("unknown transform", () => {
  it("returns original text for unknown transform", () => {
    expect(applyPasteTransform({ text: "hello", content: "" }, "nonexist")).toBe("hello");
  });
});
