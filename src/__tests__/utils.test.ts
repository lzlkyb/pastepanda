import { describe, it, expect } from "vitest";
import { relativeTime, truncate, cn, looksLikeIdentifier, parseImagePlaceholderSize, resolveImageCardDisplay, getImageOcrFullText, type ImageCardDisplayInput } from "@/lib/utils";

/** 格式化本地时间为 "YYYY-MM-DD HH:mm:ss"（与 Rust chrono::Local 写入格式一致） */
function fmtLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
    const date = fmtLocal(d);
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

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("filters falsy values", () => {
    expect(cn("foo", false, undefined, "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    // 常量条件是故意的：这里验的就是 `cond && cls` 这种写法在两种取值下的结果
    // eslint-disable-next-line no-constant-binary-expression
    expect(cn("base", true && "active", false && "hidden")).toBe("base active");
  });
});

/**
 * 标识符形态判据。这个谓词同时被 AI 打分与快捷栏兜底消费，
 * 一改就同时影响两处，所以在这里守住边界。
 */
describe("looksLikeIdentifier", () => {
  it("识别类名 / 字段名 / 常量 / 单号 / 文件名", () => {
    for (const t of [
      "itemVO",
      "INCCForHHOrSSService",
      "SYSTEMCODE",
      "MODULEID",
      "C0805041350000005382",
      "receivablebill_his.xml",
      "com.example.Foo",
      "src/lib/utils.ts",
      "v6.16.0",
    ]) {
      expect(looksLikeIdentifier(t), t).toBe(true);
    }
  });

  it("成句的自然语言不算——有空白就直接放过", () => {
    for (const t of ["hello world", "这是一句中文", "Qwen-Image 3.0", "B · 内嵌只做预览"]) {
      expect(looksLikeIdentifier(t), t).toBe(false);
    }
  });

  it("单个纯小写词不算（可能真是个外文词，该能翻译）", () => {
    expect(looksLikeIdentifier("serendipity")).toBe(false);
    expect(looksLikeIdentifier("hello")).toBe(false);
  });

  it("空串 / 纯空白不算", () => {
    expect(looksLikeIdentifier("")).toBe(false);
    expect(looksLikeIdentifier("   ")).toBe(false);
  });

  it("纯中文短标签不算标识符（它们靠长度门槛拦，不靠形态）", () => {
    expect(looksLikeIdentifier("配置组")).toBe(false);
    expect(looksLikeIdentifier("签到额度")).toBe(false);
  });
});

describe("parseImagePlaceholderSize", () => {
  it("识别 [图片] WxH 占位并提取尺寸", () => {
    expect(parseImagePlaceholderSize("[图片] 554x265")).toEqual({ width: 554, height: 265 });
    expect(parseImagePlaceholderSize("[图片] 100×200")).toEqual({ width: 100, height: 200 });
    expect(parseImagePlaceholderSize("[图片]  12 X 34")).toEqual({ width: 12, height: 34 });
  });

  it("非占位 / 格式异常返回 null", () => {
    expect(parseImagePlaceholderSize("")).toBeNull();
    expect(parseImagePlaceholderSize("[文件] 554x265")).toBeNull();
    expect(parseImagePlaceholderSize("[图片] 未知尺寸")).toBeNull();
    expect(parseImagePlaceholderSize("普通文本")).toBeNull();
  });
});

describe("resolveImageCardDisplay", () => {
  const img = (over: Partial<ImageCardDisplayInput> = {}): ImageCardDisplayInput => ({
    type: "image",
    text: "[图片] 554x265",
    content: "C:\\shots\\a.png",
    ...over,
  });

  it("后端回填非空 OCR 文本 → 标题=文本 + OCR 徽标 + 尺寸", () => {
    const d = resolveImageCardDisplay(img({ ocr_text: "pandas 导出 Excel" }));
    expect(d.title).toBe("pandas 导出 Excel");
    expect(d.ocrLabel).toBe("已识别 15 字");
    expect(d.sizeText).toBe("554×265");
  });

  it("后端回填空串（识别过无文字）→ 未识别到文字", () => {
    const d = resolveImageCardDisplay(img({ ocr_text: "" }));
    expect(d.title).toBe("未识别到文字");
    expect(d.ocrLabel).toBeUndefined();
    expect(d.sizeText).toBe("554×265");
  });

  it("前端识别中 → 识别图片文字中…", () => {
    const d = resolveImageCardDisplay(img(), { status: "ocr" });
    expect(d.title).toBe("识别图片文字中…");
  });

  it("前端识别完成且后端未回填 → 用前端结果兜底", () => {
    const d = resolveImageCardDisplay(img(), { status: "done", text: "前端识别结果" });
    expect(d.title).toBe("前端识别结果");
    expect(d.ocrLabel).toBe("已识别 6 字");
  });

  it("后端回填优先于前端结果", () => {
    const d = resolveImageCardDisplay(img({ ocr_text: "后端持久化" }), { status: "done", text: "前端结果" });
    expect(d.title).toBe("后端持久化");
  });

  it("未识别 → 文件名回退（content basename）", () => {
    const d = resolveImageCardDisplay(img());
    expect(d.title).toBe("a.png");
  });

  it("无路径 → 回退「图片」", () => {
    const d = resolveImageCardDisplay(img({ content: "" }));
    expect(d.title).toBe("图片");
  });

  it("识别失败 → 文件名回退（不显示识别中）", () => {
    const d = resolveImageCardDisplay(img(), { status: "fail" });
    expect(d.title).toBe("a.png");
  });

  it("OCR 文本超长截断（500 字符 + …，与 Card 原 title 同口径）", () => {
    const long = "字".repeat(600);
    const d = resolveImageCardDisplay(img({ ocr_text: long }));
    expect(d.title.length).toBe(501);
    expect(d.title.endsWith("…")).toBe(true);
    expect(d.ocrLabel).toBe("已识别 600 字"); // 徽标按原文长度，不受截断影响
  });
});

describe("getImageOcrFullText", () => {
  const img = (over: Partial<ImageCardDisplayInput> = {}): ImageCardDisplayInput => ({
    type: "image",
    text: "[图片] 599x874",
    content: "C:\\shots\\a.png",
    ...over,
  });

  it("后端回填非空 → 返回完整文本（未截断）", () => {
    const long = "很长的识别文字".repeat(100); // 600+ 字符
    expect(getImageOcrFullText(img({ ocr_text: long }))).toBe(long);
  });

  it("后端回填优先于前端结果", () => {
    expect(getImageOcrFullText(img({ ocr_text: "后端" }), { status: "done", text: "前端" })).toBe("后端");
  });

  it("后端为 null/undefined 时用前端识别结果兜底", () => {
    expect(getImageOcrFullText(img(), { status: "done", text: "前端识别结果" })).toBe("前端识别结果");
  });

  it("后端显式 null（Rust Option None 序列化）→ 不误判为有文字", () => {
    expect(getImageOcrFullText(img({ ocr_text: null as unknown as undefined }))).toBeNull();
  });

  it("空串（识别过但无文字）→ null", () => {
    expect(getImageOcrFullText(img({ ocr_text: "" }))).toBeNull();
  });

  it("识别中 / 失败 / 未识别 → null（无文字可复制）", () => {
    expect(getImageOcrFullText(img(), { status: "ocr" })).toBeNull();
    expect(getImageOcrFullText(img(), { status: "fail" })).toBeNull();
    expect(getImageOcrFullText(img())).toBeNull();
  });
});
