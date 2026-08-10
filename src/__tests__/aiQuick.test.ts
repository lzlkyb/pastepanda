/**
 * v6.4 主窗口 AI 感知（方案 B）：AI 快捷区动作匹配规则测试。
 */

import { describe, it, expect } from "vitest";
import { matchQuickActions } from "@/lib/aiQuick";

describe("matchQuickActions 内容匹配", () => {
  it("链接 → 链接摘要 + 总结", () => {
    const r = matchQuickActions("https://example.com/doc", "text", true);
    expect(r.map((a) => a.id)).toContain("url-summary");
    expect(r.map((a) => a.id)).toContain("ai-summarize");
  });

  it("link 类型 → 链接摘要", () => {
    const r = matchQuickActions("某条链接记录", "link", true);
    expect(r.map((a) => a.id)).toContain("url-summary");
  });

  it("含手机号 → 粘贴脱敏（本地零成本）+ 总结", () => {
    const r = matchQuickActions("请联系我 13812341234 谢谢", "text", true);
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("mask-sensitive");
    expect(ids).toContain("ai-summarize");
    // mask 是本地动作
    expect(r.find((a) => a.id === "mask-sensitive")?.ai).toBe(false);
  });

  it("英文内容 → 翻译 + 总结 + 改写", () => {
    const r = matchQuickActions("Hello world this is an English paragraph for testing purposes.", "text", true);
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("ai-translate");
    expect(ids).toContain("ai-summarize");
    expect(ids).toContain("ai-rewrite");
  });

  it("长中文文本 → 总结 + 改写 + 提取要点", () => {
    const long = "今天天气很好".repeat(60); // >200 字
    const r = matchQuickActions(long, "text", true);
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("ai-summarize");
    expect(ids).toContain("ai-key-points");
  });

  it("普通短文本 → 兜底总结 + 改写", () => {
    const r = matchQuickActions("一段普通内容", "text", true);
    expect(r.map((a) => a.id)).toEqual(["ai-summarize", "ai-rewrite"]);
  });

  it("最多 max 个且去重", () => {
    const r = matchQuickActions("Hello world this is English content here.", "text", true, 2);
    expect(r.length).toBeLessThanOrEqual(2);
    const r2 = matchQuickActions("https://a.com  https://b.com", "text", true);
    expect(new Set(r2.map((a) => a.id)).size).toBe(r2.length);
  });

  it("空文本 → 无动作", () => {
    expect(matchQuickActions("", "text", true)).toEqual([]);
  });
});

/**
 * AI 不可用（未启用 / 没配密钥）时的门控。
 *
 * 这是当时真实的缺陷：快捷区推「翻译/总结/改写」，点下去一律报错，
 * 而变换面板里 AI 分组一个动作都没（scoreAiAction 首行 return 0）——两处必须一致。
 */
describe("matchQuickActions AI 不可用时的门控", () => {
  const SAMPLES: Array<[string, string]> = [
    ["https://example.com/doc", "text"],
    ["某条链接记录", "link"],
    ["请联系我 13812341234 谢谢", "text"],
    ["Hello world this is an English paragraph for testing purposes.", "text"],
    ["今天天气很好".repeat(60), "text"],
    ["一段普通内容", "text"],
  ];

  it("任何内容都不返回 ai:true 的动作", () => {
    for (const [text, type] of SAMPLES) {
      const r = matchQuickActions(text, type, false);
      expect(r.filter((a) => a.ai)).toEqual([]);
    }
  });

  it("敏感内容 → 只剩本地的粘贴脱敏", () => {
    const r = matchQuickActions("请联系我 13812341234 谢谢", "text", false);
    expect(r.map((a) => a.id)).toEqual(["mask-sensitive"]);
  });

  it("没有本地动作可推时返回空（调用方据此整条不渲染）", () => {
    expect(matchQuickActions("一段普通内容", "text", false)).toEqual([]);
    expect(matchQuickActions("https://example.com/doc", "text", false)).toEqual([]);
  });
});
