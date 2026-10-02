/**
 * 截图 AI 弹层的列表 = 主窗口枢纽的列表（同一套打分，不是第二套规则）。
 *
 * 弹层在截图窗里，拿的是 `ai_list_actions` 的**原始元信息**；主窗口拿的是注册表里的
 * `Transform.detect`。两条数据源必须给出同一批分数与同一个顺序，否则会出现
 * 「同一个动作在枢纽排第一、在截图弹层排最后」这种查起来最痛苦的漂移。
 *
 * 做法：把后端清单喂给真实的注册路径（initAiTransforms），再拿
 * `applicableTransforms` 的 AI 组与 `buildAiPopList` 的结果对账。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({
  aiGetConfig: vi.fn(),
  aiHasKey: vi.fn(),
  aiListProviders: vi.fn(),
  aiGetUsageStats: vi.fn(),
  aiListActions: vi.fn(),
  aiListCustomActions: vi.fn(),
  aiRun: vi.fn(),
}));
vi.mock("@/lib/api/ai", () => api);

import { initAiTransforms, setAiAvailable, aiActionScore } from "@/lib/transforms/aiTransforms";
import { applicableTransforms, getTransform } from "@/lib/transforms/registry";
import { analyzeContent } from "@/lib/transforms/analyzer";
import { buildAiPopList, REC_MAX, REC_MIN_SCORE } from "@/lib/screenshot/aiPopActions";
import type { AiActionMeta, AiCustomAction } from "@/lib/api/ai";
import type { TransformContext } from "@/lib/transforms/types";

/** 后端清单的切片：手调四个里的两个 + 通用打分 + 意图型（必须 0 分）+ 不限类型 */
const ACTIONS: AiActionMeta[] = [
  { id: "ai-translate", label: "翻译", description: "翻译成其他语言", icon: "languages", maxTokens: 2000, options: [], contentTypes: ["text"] },
  { id: "ai-summarize", label: "摘要", description: "长文提炼", icon: "file-text", maxTokens: 1000, options: [], contentTypes: ["text"] },
  { id: "ai-key-points", label: "提取要点", description: "把长段落拆成条目列表", icon: "list", maxTokens: 1500, options: [], contentTypes: ["text"] },
  { id: "ai-regex-generate", label: "生成正则", description: "按描述生成正则", icon: "regex", maxTokens: 800, options: [], contentTypes: ["text"] },
  { id: "ai-explain-code", label: "解释代码", description: "讲解这段代码", icon: "code", maxTokens: 1500, options: [], contentTypes: ["code"] },
];

const CUSTOM: AiCustomAction = {
  id: "aic-1", name: "缩写", description: "压到一半长度", icon: "minus",
  template: "缩写：{{内容}}", maxTokens: 500, contentTypes: ["text"],
  enabled: true, sortOrder: 0, createdAt: "", updatedAt: "",
};

const LONG_EN = "The quick brown fox jumps over the lazy dog. ".repeat(8);

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

/** 主窗口那侧：注册表里 AI 组、score>0、降序的 id 序列 */
function hubAiOrder(c: TransformContext): string[] {
  return applicableTransforms(c)
    .filter((x) => x.transform.group === "ai")
    .map((x) => x.transform.id);
}

beforeEach(async () => {
  vi.clearAllMocks();
  setAiAvailable(true);
  api.aiGetConfig.mockResolvedValue({ enabled: true, provider: "openai", model: "gpt-4o-mini" });
  api.aiHasKey.mockResolvedValue(true);
  api.aiListProviders.mockResolvedValue([{ id: "openai", needsKey: true }]);
  api.aiGetUsageStats.mockResolvedValue({ totalCalls: 0 });
  api.aiListActions.mockResolvedValue(ACTIONS);
  api.aiListCustomActions.mockResolvedValue([CUSTOM]);
  await initAiTransforms();
});

describe("弹层与枢纽同一口径", () => {
  it("每个动作的注册表 detect 分 = 弹层用的 aiActionScore 分", () => {
    const c = ctx(LONG_EN);
    for (const a of [...ACTIONS, { id: CUSTOM.id, contentTypes: CUSTOM.contentTypes }]) {
      const t = getTransform(a.id);
      expect(t, `${a.id} 未注册`).toBeDefined();
      expect(t!.detect(c)).toBe(aiActionScore(a.id, a.contentTypes, c));
    }
  });

  it("过线动作的先后顺序两边一致（含自定义动作）", () => {
    const c = ctx(LONG_EN);
    const list = buildAiPopList([...ACTIONS], c, "");
    const popPositive = [...list.rec, ...list.rest]
      .filter((a) => aiActionScore(a.id, a.contentTypes ?? [], c) >= REC_MIN_SCORE)
      .map((a) => a.id);
    const hubPositive = hubAiOrder(c).filter((id) => {
      const meta = ACTIONS.find((a) => a.id === id);
      return meta && aiActionScore(id, meta.contentTypes, c) >= REC_MIN_SCORE;
    });
    expect(popPositive.length).toBeGreaterThan(1);
    expect(popPositive).toEqual(hubPositive);
  });

  it("意图型动作（生成正则）拿 0 分，进不了推荐段", () => {
    const list = buildAiPopList([...ACTIONS], ctx(LONG_EN), "");
    expect(list.rec.map((a) => a.id)).not.toContain("ai-regex-generate");
    expect(aiActionScore("ai-regex-generate", ["text"], ctx(LONG_EN))).toBe(0);
  });

  it("推荐段最多 REC_MAX 条，其余留在 rest 里而不是被丢掉", () => {
    const list = buildAiPopList([...ACTIONS], ctx(LONG_EN), "");
    expect(list.rec.length).toBeLessThanOrEqual(REC_MAX);
    expect(list.rec.length + list.rest.length).toBe(ACTIONS.length);
  });

  it("代码内容不推荐翻译，但推荐解释代码", () => {
    const code = "fn main() { let x = 1; println!(\"{}\", x); }";
    const list = buildAiPopList([...ACTIONS], ctx(code, "code"), "");
    expect(list.rec.map((a) => a.id)).toContain("ai-explain-code");
    expect(list.rec.map((a) => a.id)).not.toContain("ai-translate");
  });

  it("AI 不可用时整个弹层为空（规则 16：零可见）", () => {
    setAiAvailable(false);
    const list = buildAiPopList([...ACTIONS], ctx(LONG_EN), "");
    expect(list.rec).toEqual([]);
    expect(list.rest.every((a) => aiActionScore(a.id, a.contentTypes ?? [], ctx(LONG_EN)) === 0)).toBe(true);
    setAiAvailable(true);
  });
});

describe("搜索态", () => {
  it("命中时不分段，matched 给真实条数", () => {
    const list = buildAiPopList([...ACTIONS], ctx(LONG_EN), "要点");
    expect(list.matched).toBe(1);
    expect(list.rec).toEqual([]);
    expect(list.rest.map((a) => a.id)).toEqual(["ai-key-points"]);
  });

  it("大小写不敏感，也能用英文 id 搜", () => {
    expect(buildAiPopList([...ACTIONS], ctx(LONG_EN), "TRANSLATE").matched).toBe(1);
    expect(buildAiPopList([...ACTIONS], ctx(LONG_EN), "regex").matched).toBe(1);
  });

  it("无匹配返回空列表而不是全清单（搜索框非空时不许回落到默认列表）", () => {
    const list = buildAiPopList([...ACTIONS], ctx(LONG_EN), "zzz不存在");
    expect(list.matched).toBe(0);
    expect(list.rest).toEqual([]);
  });

  it("空白查询等于未搜索：仍走打分分段", () => {
    expect(buildAiPopList([...ACTIONS], ctx(LONG_EN), "   ").matched).toBe(null);
  });

  // 本地分类是异步的，也可能直接失败。搜索是纯字符串匹配，用不着 contentType，
  // 所以 ctx 没到也不能让搜索框变成摆设（否则就是规则 15.3 的静默失效）。
  it("ctx 为 null 时搜索照样过滤", () => {
    const list = buildAiPopList([...ACTIONS], null, "要点");
    expect(list.matched).toBe(1);
    expect(list.rest.map((a) => a.id)).toEqual(["ai-key-points"]);
  });

  it("ctx 为 null 时不排推荐段，按清单原序平铺而不是猜一个顺序", () => {
    const list = buildAiPopList([...ACTIONS], null, "");
    expect(list.rec).toEqual([]);
    expect(list.rest.map((a) => a.id)).toEqual(ACTIONS.map((a) => a.id));
  });
});
