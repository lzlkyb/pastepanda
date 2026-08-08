/**
 * 云端 AI 动作的匹配度打分。
 *
 * 重点盯两件事：
 * 1. **未配置时全部返回 0** —— 否则界面上会摆一排点下去才报错的按钮；
 * 2. 代码/结构化内容不该推荐翻译与改写（会把标识符一并改掉）。
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  scoreAiAction,
  scoreByContentTypes,
  setAiAvailable,
} from "@/lib/transforms/aiTransforms";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

const LONG_EN =
  "The quick brown fox jumps over the lazy dog. ".repeat(8); // > 200 字符的纯 ASCII

describe("AI 动作匹配度", () => {
  beforeEach(() => setAiAvailable(true));
  afterAll(() => setAiAvailable(false));

  it("未配置 AI 时所有动作都是 0 分（根本不出现在界面上）", () => {
    setAiAvailable(false);
    for (const id of ["ai-translate", "ai-summarize", "ai-explain-code", "ai-rewrite"]) {
      expect(scoreAiAction(id, ctx(LONG_EN))).toBe(0);
    }
  });

  it("纯 ASCII 成段文字优先推荐翻译", () => {
    const en = scoreAiAction("ai-translate", ctx("This is a plain English sentence."));
    const zh = scoreAiAction("ai-translate", ctx("这是一句中文，里面带有非 ASCII 字符。"));
    expect(en).toBeGreaterThan(zh);
    expect(zh).toBeGreaterThan(0);
  });

  it("太短的内容不推荐翻译", () => {
    expect(scoreAiAction("ai-translate", ctx("hi"))).toBe(0);
  });

  it("代码不推荐翻译/改写，但高分推荐解释代码", () => {
    const c = ctx("function add(a, b) { return a + b; }", "code");
    expect(scoreAiAction("ai-translate", c)).toBe(0);
    expect(scoreAiAction("ai-rewrite", c)).toBe(0);
    expect(scoreAiAction("ai-explain-code", c)).toBeGreaterThan(0.8);
  });

  it("非代码内容不推荐解释代码", () => {
    expect(scoreAiAction("ai-explain-code", ctx("今天天气不错，适合出门散步。"))).toBe(0);
  });

  it("短文本不推荐摘要，长文本才推荐", () => {
    expect(scoreAiAction("ai-summarize", ctx("很短的一句话"))).toBe(0);
    expect(scoreAiAction("ai-summarize", ctx(LONG_EN))).toBeGreaterThan(0);
  });

  it("未知动作 id 返回 0 而不是报错", () => {
    expect(scoreAiAction("ai-不存在的动作", ctx(LONG_EN))).toBe(0);
  });
});

describe("按内容类型打分（新增内置动作与自定义动作共用）", () => {
  beforeEach(() => setAiAvailable(true));
  afterAll(() => setAiAvailable(false));

  it("未配置 AI 时一律 0 分", () => {
    setAiAvailable(false);
    expect(scoreByContentTypes([], ctx("hello"))).toBe(0);
    expect(scoreByContentTypes(["text"], ctx("hello"))).toBe(0);
  });

  it("勾了类型且命中 → 在同一段内容上要排在内置动作之前", () => {
    // 必须在**同一个 ctx** 上比：跨内容比分数没有意义
    const json = ctx('{"a":1}', "json");
    const custom = scoreByContentTypes(["json"], json);
    expect(custom).toBeGreaterThan(scoreAiAction("ai-translate", json));
    expect(custom).toBeGreaterThan(scoreAiAction("ai-rewrite", json));
  });

  it("勾了类型但不命中 → 0 分，根本不显示", () => {
    expect(scoreByContentTypes(["json"], ctx("一段普通文字", "text"))).toBe(0);
  });

  it("一个都没勾 = 适用全部，但要排在内置动作之后", () => {
    // 一段够长的中文：内置翻译在这里是 0.55
    const zh = ctx("这是一段足够长的中文内容，用来触发翻译与改写的推荐。".repeat(3));
    const anyType = scoreByContentTypes([], zh);
    expect(anyType).toBeGreaterThan(0);
    // 关键约束：“适用全部”的自定义动作不能把真正对口的内置动作挤下去
    expect(anyType).toBeLessThan(scoreAiAction("ai-translate", zh));
    // 也要低于“勾了类型且命中”的那档
    expect(anyType).toBeLessThan(scoreByContentTypes(["text"], zh));
  });
});
