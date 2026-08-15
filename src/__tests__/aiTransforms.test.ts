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
  languageTag,
  tagBoost,
} from "@/lib/transforms/aiTransforms";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

/** 带标签的上下文 */
function ctxTagged(
  text: string,
  contentType: string,
  tags: Array<{ name: string; source: "manual" | "auto" }>,
): TransformContext {
  return { ...ctx(text, contentType), tags };
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
    expect(scoreByContentTypes("custom-any", [], ctx("hello"))).toBe(0);
    expect(scoreByContentTypes("custom-text", ["text"], ctx("hello"))).toBe(0);
  });

  it("勾了类型且命中 → 在同一段内容上要排在内置动作之前", () => {
    // 必须在**同一个 ctx** 上比：跨内容比分数没有意义
    const json = ctx('{"a":1}', "json");
    const custom = scoreByContentTypes("custom-json", ["json"], json);
    expect(custom).toBeGreaterThan(scoreAiAction("ai-translate", json));
    expect(custom).toBeGreaterThan(scoreAiAction("ai-rewrite", json));
  });

  it("勾了类型但不命中 → 0 分，根本不显示", () => {
    expect(scoreByContentTypes("custom-json", ["json"], ctx("一段普通文字", "text"))).toBe(0);
  });

  it("语言级标签把解释代码再推高一档", () => {
    const plain = ctx("function a() { return 1 }", "code");
    const withLang = ctxTagged("function a() { return 1 }", "code", [
      { name: "代码", source: "auto" },
      { name: "TypeScript", source: "auto" },
    ]);
    expect(languageTag(withLang)).toBe("TypeScript");
    expect(languageTag(plain)).toBeUndefined();
    expect(scoreAiAction("ai-explain-code", withLang)).toBeGreaterThan(
      scoreAiAction("ai-explain-code", plain),
    );
  });

  it("只认 auto 来源的语言标签（手工打个叫 Rust 的标签不算）", () => {
    const manualRust = ctxTagged("fn a() {}", "code", [{ name: "Rust", source: "manual" }]);
    expect(languageTag(manualRust)).toBeUndefined();
  });

  it("一个都没勾 = 适用全部，但要排在内置动作之后", () => {
    // 一段够长的中文：内置翻译在这里是 0.55
    const zh = ctx("这是一段足够长的中文内容，用来触发翻译与改写的推荐。".repeat(3));
    const anyType = scoreByContentTypes("custom-any", [], zh);
    expect(anyType).toBeGreaterThan(0);
    // 关键约束：“适用全部”的自定义动作不能把真正对口的内置动作挤下去
    expect(anyType).toBeLessThan(scoreAiAction("ai-translate", zh));
    // 也要低于“勾了类型且命中”的那档
    expect(anyType).toBeLessThan(scoreByContentTypes("custom-text", ["text"], zh));
  });
});

/**
 * 手工标签带来的动作提权。
 *
 * 这几个动作靠的是**用户意图**，文本里根本判不出来，
 * 没标签之前它们只能拿通用分、几乎永远排不上来。
 */
describe("手工标签提权", () => {
  beforeEach(() => setAiAvailable(true));
  afterAll(() => setAiAvailable(false));

  it("“待回复”把回复草稿提上来", () => {
    const c = ctxTagged("明天开会吗？", "text", [{ name: "待回复", source: "manual" }]);
    expect(tagBoost("ai-reply-draft", c)).toBeGreaterThan(0);
    // 不相关的动作不能跟着涨
    expect(tagBoost("ai-translate", c)).toBe(0);
  });

  it("只认 manual：自动标签不携带意图", () => {
    const c = ctxTagged("x", "text", [{ name: "待回复", source: "auto" }]);
    expect(tagBoost("ai-reply-draft", c)).toBe(0);
  });

  it("没标签 = 0，不改变任何现有行为", () => {
    expect(tagBoost("ai-reply-draft", ctx("x"))).toBe(0);
    expect(tagBoost("ai-weekly-report", ctxTagged("x", "text", []))).toBe(0);
  });

  it("AI 不可用时标签也不能把动作推成正分", () => {
    setAiAvailable(false);
    const c = ctxTagged("x", "text", [{ name: "待回复", source: "manual" }]);
    expect(tagBoost("ai-reply-draft", c)).toBe(0);
  });
});

/**
 * v6.16 打分修正。
 *
 * **每条断言都对应一个真实数据里量到的错**——拿本机库里 492 条历史
 * 跑 applicableTransforms + matchQuickActions 回放出来的，不是想象的边界。
 * 它们的作用是防回归：无论以后动作表怎么改，这几类内容不得再拿到这几个动作。
 */
describe("v6.16 打分修正（真实数据驱动）", () => {
  beforeEach(() => setAiAvailable(true));
  afterAll(() => setAiAvailable(false));

  /** 真实历史里的原文。改动前它们全被推了“翻译”，而且占第一个按钮。 */
  const IDENTIFIERS = [
    "SYSTEMCODE",
    "INCCForHHOrSSService",
    "C0805041350000005382",
    "receivablebill_his.xml",
    "itemVO",
  ];

  it("标识符 / 类名 / 单号 / 文件名不推翻译（改动前占 slot1 的 31.1%）", () => {
    for (const t of IDENTIFIERS) {
      expect(scoreAiAction("ai-translate", ctx(t)), t).toBe(0);
    }
  });

  it("成句的纯 ASCII 仍然推翻译——修的是形态判据，不是把翻译关掉", () => {
    expect(scoreAiAction("ai-translate", ctx(LONG_EN))).toBeGreaterThan(0);
    // 单个纯小写词可能真是外文词，不当标识符
    expect(scoreAiAction("ai-translate", ctx("serendipity"))).toBeGreaterThan(0);
  });

  it("标识符也不推润色 / 要点 / 表格化（它们没有错别字，也没有要点）", () => {
    for (const t of IDENTIFIERS) {
      expect(scoreByContentTypes("ai-polish", ["text"], ctx(t)), t).toBe(0);
      expect(scoreByContentTypes("ai-key-points", ["text"], ctx(t)), t).toBe(0);
      expect(scoreByContentTypes("ai-tabulate", ["text"], ctx(t)), t).toBe(0);
    }
  });

  it("3 个字的标签不推提取要点（改动前 <10 字条目有 79.7% 拿到它）", () => {
    const tiny = ctx("配置组");
    expect(scoreByContentTypes("ai-key-points", ["text"], tiny)).toBe(0);
    expect(scoreByContentTypes("ai-polish", ["text"], tiny)).toBe(0);
  });

  it("够长的中文段落照旧推要点——长度闸不能把真正该推的也滤掉", () => {
    const long = ctx("这是一段足够长的中文内容，用来验证提取要点在长文上仍然生效。".repeat(5));
    expect(scoreByContentTypes("ai-key-points", ["text"], long)).toBeGreaterThan(0);
  });

  it("意图型动作基础分为 0：内容本身判不出该不该用它们", () => {
    // 实测占位：生成正则 44.9%、合并整理 17.3%、生成周报 15.0%
    const c = ctx("随便一段够长的普通中文内容，用来确认它们不再靠内容浮现");
    for (const id of [
      "ai-regex-generate",
      "ai-sql-generate",
      "ai-reply-draft",
      "ai-weekly-report",
      "ai-merge-polish",
    ]) {
      expect(scoreByContentTypes(id, ["text"], c), id).toBe(0);
    }
  });

  it("意图型归零不等于消失：标签仍能把它提回来", () => {
    const c = ctxTagged("明天开会吗？", "text", [{ name: "待回复", source: "manual" }]);
    // 基础分 0，但 toTransform 里是 Math.max(base, tagBoost)
    expect(scoreByContentTypes("ai-reply-draft", ["text"], c)).toBe(0);
    expect(tagBoost("ai-reply-draft", c)).toBeGreaterThan(0);
  });

  it("追问不进推荐（但必须仍能被 getTransform 拿到，否则追问功能整个坏掉）", () => {
    expect(scoreByContentTypes("ai-followup", ["text"], ctx("一段够长的普通中文内容用于验证"))).toBe(0);
  });
});
