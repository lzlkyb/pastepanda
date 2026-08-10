/**
 * v6.4 主窗口 AI 感知（方案 B）：AI 快捷区动作匹配规则测试。
 */

import { describe, it, expect } from "vitest";
import { matchQuickActions } from "@/lib/aiQuick";

describe("matchQuickActions 内容匹配", () => {
  it("链接 → 链接摘要 + 总结", () => {
    const r = matchQuickActions("https://example.com/doc", "text");
    expect(r.map((a) => a.id)).toContain("url-summary");
    expect(r.map((a) => a.id)).toContain("ai-summarize");
  });

  it("link 类型 → 链接摘要", () => {
    const r = matchQuickActions("某条链接记录", "link");
    expect(r.map((a) => a.id)).toContain("url-summary");
  });

  it("含手机号 → 粘贴脱敏（本地零成本）+ 总结", () => {
    const r = matchQuickActions("请联系我 13812341234 谢谢", "text");
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("mask-sensitive");
    expect(ids).toContain("ai-summarize");
    // mask 是本地动作
    expect(r.find((a) => a.id === "mask-sensitive")?.ai).toBe(false);
  });

  it("英文内容 → 翻译 + 总结 + 改写", () => {
    const r = matchQuickActions("Hello world this is an English paragraph for testing purposes.", "text");
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("ai-translate");
    expect(ids).toContain("ai-summarize");
    expect(ids).toContain("ai-rewrite");
  });

  it("长中文文本 → 总结 + 改写 + 提取要点", () => {
    const long = "今天天气很好".repeat(60); // >200 字
    const r = matchQuickActions(long, "text");
    const ids = r.map((a) => a.id);
    expect(ids[0]).toBe("ai-summarize");
    expect(ids).toContain("ai-key-points");
  });

  it("普通短文本 → 兜底总结 + 改写", () => {
    const r = matchQuickActions("一段普通内容", "text");
    expect(r.map((a) => a.id)).toEqual(["ai-summarize", "ai-rewrite"]);
  });

  it("最多 max 个且去重", () => {
    const r = matchQuickActions("Hello world this is English content here.", "text", 2);
    expect(r.length).toBeLessThanOrEqual(2);
    const r2 = matchQuickActions("https://a.com  https://b.com", "text");
    expect(new Set(r2.map((a) => a.id)).size).toBe(r2.length);
  });

  it("空文本 → 无动作", () => {
    expect(matchQuickActions("", "text")).toEqual([]);
  });
});
