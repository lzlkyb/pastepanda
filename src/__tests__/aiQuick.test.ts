/**
 * AI 快捷区的动作取舍策略测试。
 *
 * 注意本文件不再测“什么内容匹配什么动作”——那是 `detect()` / `scoreAiAction`
 * 的职责（见 aiTransforms 相关测试）。这里只测四件事：
 * 白名单、出网标记、短文本兜底、路径派生输入的禁出网。
 *
 * 候选列表是依赖注入的（模拟 applicableTransforms 已按分降序的结果），
 * 所以不需要初始化整个变换注册表。
 */

import { describe, it, expect } from "vitest";
import { matchQuickActions, type QuickCandidate } from "@/lib/aiQuick";

/** label 统一等于 id，断言时只看 id 就够 */
const cand = (id: string, group: string, remote?: boolean): QuickCandidate => ({
  id,
  label: id,
  group,
  remote,
});

/** 真实的 AI 变换都是 group:"ai" + remote:true（见 aiTransforms 的工厂） */
const ai = (id: string) => cand(id, "ai", true);

const TEXT = "一段普通内容";

describe("matchQuickActions 白名单", () => {
  it("非 ai 分组且不在白名单里的动作全部剔除", () => {
    // 变换中心会把大小写/base64/SQL 格式化等几十个一起排上来，
    // 快捷栏只有 2-3 个位，不能变成第二个变换中心
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [cand("upper", "text"), cand("base64_encode", "web"), ai("ai-summarize")],
    });
    expect(r.map((a) => a.id)).toEqual(["ai-summarize"]);
  });

  it("保留候选的原有顺序（已由打分排好，不在这里重排）", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [cand("mask-sensitive", "text"), ai("ai-explain-code"), ai("ai-rewrite")],
    });
    expect(r.map((a) => a.id)).toEqual(["mask-sensitive", "ai-explain-code", "ai-rewrite"]);
  });

  it("本地动作标为 ai:false，不会被当成计费动作", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [cand("mask-sensitive", "text")],
    });
    expect(r.find((a) => a.id === "mask-sensitive")?.ai).toBe(false);
  });

  it("去重与 max 截断", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [ai("ai-summarize"), ai("ai-summarize"), ai("ai-rewrite"), ai("ai-key-points")],
      max: 2,
    });
    expect(r.map((a) => a.id)).toEqual(["ai-summarize", "ai-rewrite"]);
  });

  it("空文本 → 无动作", () => {
    expect(matchQuickActions({ text: "", aiOk: true, candidates: [ai("ai-summarize")] })).toEqual([]);
    expect(matchQuickActions({ text: "   ", aiOk: true, candidates: [ai("ai-summarize")] })).toEqual([]);
  });
});

/**
 * url-summary 的 group 是 "web"、且自己没标 remote，但它会实际抓取那个 URL（内容出网）。
 * 风险标记一个都不能漏，所以必须被当成 ai:true。
 */
describe("matchQuickActions 出网标记", () => {
  it("url-summary 虽然不在 ai 分组也没标 remote，仍计为出网", () => {
    const r = matchQuickActions({
      text: "https://example.com/doc",
      aiOk: true,
      candidates: [cand("url-summary", "web")],
    });
    expect(r[0]?.ai).toBe(true);
  });

  it("remote:true 的非 ai 分组动作也算出网", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [cand("mask-sensitive", "text", true)],
    });
    expect(r[0]?.ai).toBe(true);
  });
});

/**
 * scoreAiAction 里 ai-summarize 要求 >200 字、ai-rewrite 要求 ≥50 字，
 * 所以“复制了一句话”这个最常见场景会一个候选都拿不到。
 */
describe("matchQuickActions 短文本兜底", () => {
  it("一个 AI 候选都没时补上总结 + 改写", () => {
    const r = matchQuickActions({ text: TEXT, aiOk: true, candidates: [] });
    expect(r.map((a) => a.id)).toEqual(["ai-summarize", "ai-rewrite"]);
  });

  it("已有 AI 候选时不追加兜底", () => {
    const r = matchQuickActions({ text: TEXT, aiOk: true, candidates: [ai("ai-explain-code")] });
    expect(r.map((a) => a.id)).toEqual(["ai-explain-code"]);
  });

  it("只有本地候选时仍补兜底（本地动作不算 AI）", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: true,
      candidates: [cand("mask-sensitive", "text")],
    });
    expect(r.map((a) => a.id)).toEqual(["mask-sensitive", "ai-summarize", "ai-rewrite"]);
  });
});

/**
 * AI 不可用（未启用 / 没配密钥）时的门控。
 *
 * 这是当时真实的缺陷：快捷区推「翻译/总结/改写」，点下去一律报错，
 * 而变换面板里 AI 分组一个动作都没（scoreAiAction 首行 return 0）——两处必须一致。
 */
describe("matchQuickActions AI 不可用时的门控", () => {
  it("不返回任何 ai:true 的动作", () => {
    const r = matchQuickActions({
      text: TEXT,
      aiOk: false,
      candidates: [ai("ai-summarize"), cand("url-summary", "web"), cand("mask-sensitive", "text")],
    });
    expect(r.filter((a) => a.ai)).toEqual([]);
  });

  it("敏感内容 → 只剩本地的粘贴脱敏", () => {
    const r = matchQuickActions({
      text: "请联系我 13812341234 谢谢",
      aiOk: false,
      candidates: [cand("mask-sensitive", "text"), ai("ai-summarize")],
    });
    expect(r.map((a) => a.id)).toEqual(["mask-sensitive"]);
  });

  it("没有本地动作可推时返回空（调用方据此整条不渲染）", () => {
    expect(matchQuickActions({ text: TEXT, aiOk: false, candidates: [] })).toEqual([]);
    expect(
      matchQuickActions({ text: TEXT, aiOk: false, candidates: [ai("ai-explain-code")] }),
    ).toEqual([]);
  });
});

/**
 * 图片/文件支路：item.text 为空，输入从 content 里的路径派生。
 * 路径里带用户名、目录结构、项目名，不能因为“反正有个输入”就隐式发给模型。
 */
describe("matchQuickActions 路径派生输入（图片/文件支路）", () => {
  const PATHS = "C:\\Users\\me\\project\\a.txt\nC:\\Users\\me\\project\\b.txt";

  it("只给本地路径动作", () => {
    const r = matchQuickActions({
      text: PATHS,
      aiOk: true,
      pathDerived: true,
      candidates: [
        cand("path_name", "text"),
        cand("path_fslash", "text"),
        cand("path_bslash", "text"),
      ],
    });
    expect(r.map((a) => a.id)).toEqual(["path_name", "path_fslash", "path_bslash"]);
    expect(r.every((a) => !a.ai)).toBe(true);
  });

  it("AI 可用也不把路径交给出网动作", () => {
    const r = matchQuickActions({
      text: PATHS,
      aiOk: true,
      pathDerived: true,
      candidates: [ai("ai-summarize"), cand("url-summary", "web"), cand("path_name", "text")],
    });
    expect(r.map((a) => a.id)).toEqual(["path_name"]);
  });

  it("不走短文本兜底（兜底项全是出网动作）", () => {
    expect(
      matchQuickActions({ text: PATHS, aiOk: true, pathDerived: true, candidates: [] }),
    ).toEqual([]);
  });
});
