/**
 * v6.4 A 链接摘要测试。
 *
 * 重点：
 * 1. detect：link 类型 / URL 文本 → 高置信；普通文本 → 0（不误命中）；
 * 2. run 阶段 1（本地）：mock 后端返回标题+正文 → 产出「标题\n\n正文截断」；
 * 3. run 阶段 2（AI 精炼）：AI 可用时优先精炼；精炼失败自动退回粗摘要（规则 15 门控）；
 * 4. run：非 URL → 失败提示；后端失败 → 错误透传。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { urlSummaryTransform } from "@/lib/transforms/urlSummaryTransform";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

/** 阶段 1 抓取返回（fetch_url_summary） */
const FETCH_OK = { url: "https://example.com/a", title: "测试文章", text: "这是一段足够长的正文内容。".repeat(40) };

beforeEach(() => {
  vi.clearAllMocks();
  setAiAvailable(false); // 阶段 2 测试临时开启，其他测试保持关闭
});

describe("detect 命中判定", () => {
  it("contentType link → 高置信", () => {
    expect(urlSummaryTransform.detect(ctx("https://example.com/article/1", "link"))).toBeGreaterThan(0);
  });

  it("纯 URL 文本 → 高置信", () => {
    expect(urlSummaryTransform.detect(ctx("https://example.com/article/2"))).toBeGreaterThan(0);
  });

  it("普通文本 → 0（不误命中）", () => {
    expect(urlSummaryTransform.detect(ctx("今天天气不错"))).toBe(0);
    expect(urlSummaryTransform.detect(ctx("这不是链接 example.com"))).toBe(0);
  });
});

describe("run 产出摘要", () => {
  it("标题 + 正文截断", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: "https://example.com/a",
      title: "测试文章",
      text: "这是一段足够长的正文内容。".repeat(40),
    });
    const r = await urlSummaryTransform.run("https://example.com/a");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("测试文章");
    expect(r.output!.length).toBeLessThanOrEqual(400);
  });

  it("空正文 → 只输出标题", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: "https://example.com/b",
      title: "只有标题",
      text: "",
    });
    const r = await urlSummaryTransform.run("https://example.com/b");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("只有标题");
  });

  it("非 URL → 失败", async () => {
    const r = await urlSummaryTransform.run("这不是链接");
    expect(r.ok).toBe(false);
  });

  it("后端失败 → 错误透传", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      "抓取失败（站点可能反爬或需要登录）",
    );
    const r = await urlSummaryTransform.run("https://example.com/c");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("反爬");
  });
});

describe("阶段 2：AI 精炼（规则 15 门控）", () => {
  it("AI 可用 → 优先输出 ai-summarize 精炼结果", async () => {
    setAiAvailable(true);
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(FETCH_OK) // fetch_url_summary
      .mockResolvedValueOnce({ status: "ok", content: "AI 精炼后的要点", model: "test", cached: false, promptTokens: 1, completionTokens: 1, truncated: false }); // ai_run
    const r = await urlSummaryTransform.run("https://example.com/a");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("AI 精炼后的要点");
  });

  it("AI 可用但精炼失败 → 自动退回粗摘要", async () => {
    setAiAvailable(true);
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(FETCH_OK) // fetch_url_summary
      .mockRejectedValueOnce(new Error("网络错误")); // ai_run reject
    const r = await urlSummaryTransform.run("https://example.com/a");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("测试文章"); // 退回阶段 1
  });

  it("AI 可用但需确认/超预算 → 退回粗摘要（不卡确认）", async () => {
    setAiAvailable(true);
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(FETCH_OK)
      .mockResolvedValueOnce({ status: "budgetExceeded", spentCny: 9, budgetCny: 5 });
    const r = await urlSummaryTransform.run("https://example.com/a");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("测试文章");
  });

  it("AI 不可用 → 不调 ai_run，纯粗摘要", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(FETCH_OK)
      .mockResolvedValueOnce({ status: "ok", content: "不应被调用的AI", model: "m", cached: false, promptTokens: 1, completionTokens: 1, truncated: false });
    const r = await urlSummaryTransform.run("https://example.com/a");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("正文内容"); // 粗摘要
    expect(r.output).not.toContain("不应被调用的AI");
  });
});
