/**
 * intent.test.ts — 意图识别引擎（V3-A）规则测试。
 */
import { describe, it, expect } from "vitest";
import { detectIntent } from "@/lib/intent";

const ctx = (text: string, contentType = "text") => ({ text, contentType });

describe("detectIntent · 排错意图", () => {
  it("报错关键字 + 代码类 → troubleshoot", () => {
    const i = detectIntent(ctx("Error: cannot find module 'react'\n  at webpack...", "code"));
    expect(i).not.toBeNull();
    expect(i!.id).toBe("troubleshoot");
    expect(i!.actionIds[0]).toBe("ai-explain-code");
  });

  it("中文报错也识别", () => {
    const i = detectIntent(ctx("异常：连接超时，请检查网络后重试", "log"));
    expect(i?.id).toBe("troubleshoot");
  });

  it("普通文本无报错关键字 → 不误报", () => {
    const i = detectIntent(ctx("今天天气不错"));
    expect(i?.id).not.toBe("troubleshoot");
  });
});

describe("detectIntent · JSON/结构化意图", () => {
  it("JSON 对象 → json-shape（生成类型优先）", () => {
    const i = detectIntent(ctx('{"name":"x","age":1}', "json"));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds).toContain("ai-json-to-type");
  });

  it("JSON 数组 → json-shape（转 SQL 优先）", () => {
    const i = detectIntent(ctx("[1,2,3]", "json"));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds[0]).toBe("json_format");
    expect(i!.actionIds).toContain("query-result-to-sql");
  });
});

describe("detectIntent · 收集链接", () => {
  it("单条含 2+ URL → collect-links", () => {
    const i = detectIntent(
      ctx("参考 https://docs.rs/rmcp 和 https://github.com/x/y 的文档"),
    );
    expect(i?.id).toBe("collect-links");
    expect(i!.actionIds).toContain("url-summary");
  });

  it("最近连续 2 条链接 + 当前也含链接 → collect-links", () => {
    const i = detectIntent(
      ctx("再看这个 https://example.com/a"),
      undefined,
      [{ text: "https://example.com/1" }, { text: "https://example.com/2" }],
    );
    expect(i?.id).toBe("collect-links");
  });
});

describe("detectIntent · 批量数据", () => {
  it("3+ IP → batch（合并 SQL IN）", () => {
    const i = detectIntent(ctx("192.168.1.1\n192.168.1.2\n192.168.1.3"));
    expect(i?.id).toBe("batch");
    expect(i!.actionIds).toContain("sql-in");
  });

  it("3+ 手机号 → batch", () => {
    const i = detectIntent(ctx("13812345678 13900001111 13712349999"));
    expect(i?.id).toBe("batch");
  });
});

describe("detectIntent · 长文本提炼", () => {
  it("500+ 字文本 → digest", () => {
    const long = "测试内容".repeat(130); // 520 字
    const i = detectIntent(ctx(long));
    expect(i?.id).toBe("digest");
    expect(i!.actionIds[0]).toBe("ai-summarize");
  });

  it("短文本不触发 digest", () => {
    const i = detectIntent(ctx("短文本"));
    expect(i?.id).not.toBe("digest");
  });
});

describe("detectIntent · 财务", () => {
  it("≥2 处金额 → finance", () => {
    const i = detectIntent(ctx("A 项 ¥123.45，B 项 ¥678.90，合计约 ¥800"));
    expect(i?.id).toBe("finance");
    expect(i!.actionIds[0]).toBe("ai-tabulate");
  });
});

describe("detectIntent · 综合", () => {
  it("空文本 / 未知内容 → null", () => {
    expect(detectIntent(ctx(""))).toBeNull();
    expect(detectIntent(ctx("  \n  "))).toBeNull();
  });

  it("只返回置信度最高的一个意图", () => {
    // 同时是报错 + 长文本 → 取置信更高的 troubleshoot
    const i = detectIntent(ctx("Error: something failed\n" + "x".repeat(600), "code"));
    expect(i?.id).toBe("troubleshoot");
  });
});
