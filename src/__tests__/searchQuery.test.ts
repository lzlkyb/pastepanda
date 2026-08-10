/**
 * v6.4 D 搜索阶段 2：自然语言查询解析测试。
 *
 * 重点：
 * 1. 句首时间词 → 对应 timeFilter；
 * 2. **关键词原样保留**（误判也只是范围收窄，绝不丢字）；
 * 3. 普通关键词 → timeFilter all。
 */

import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "@/lib/searchQuery";

describe("句首时间词解析", () => {
  it("上周 → week", () => {
    const r = parseSearchQuery("上周复制的那个API文档");
    expect(r.timeFilter).toBe("week");
    expect(r.keyword).toBe("上周复制的那个API文档"); // 关键词原样
  });

  it("今天 → today", () => {
    expect(parseSearchQuery("今天的内容").timeFilter).toBe("today");
  });

  it("本周/这周 → week", () => {
    expect(parseSearchQuery("本周工作").timeFilter).toBe("week");
    expect(parseSearchQuery("这周提交的代码").timeFilter).toBe("week");
  });

  it("上个月 → month", () => {
    expect(parseSearchQuery("上个月的报表").timeFilter).toBe("month");
  });
});

describe("关键词保留（误判代价最小化）", () => {
  it("「今天天气」命中 today 但关键词原样保留", () => {
    const r = parseSearchQuery("今天天气");
    expect(r.timeFilter).toBe("today");
    expect(r.keyword).toBe("今天天气");
  });

  it("普通关键词 → all", () => {
    const r = parseSearchQuery("API 文档");
    expect(r.timeFilter).toBe("all");
    expect(r.keyword).toBe("API 文档");
  });

  it("空串 → all + 空", () => {
    const r = parseSearchQuery("   ");
    expect(r.timeFilter).toBe("all");
    expect(r.keyword).toBe("");
  });

  it("时间词不在句首 → 不解析（all）", () => {
    const r = parseSearchQuery("那个上周的链接");
    expect(r.timeFilter).toBe("all");
    expect(r.keyword).toBe("那个上周的链接");
  });
});
