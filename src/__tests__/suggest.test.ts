/**
 * v6.2 主动建议模块测试。
 *
 * 约束重点：
 * 1. **不确定就不主动**：top-1 分数 < 阈值必须返回 null（"给列表说明你不确定"）；
 * 2. **序列识别只认同类**：3 个 IP / 3 个邮箱 → 合并建议；混合类型绝不建议；
 * 3. **数量下限**：不足 3 条同类不产生序列建议。
 * 4. **不承诺做不到的事**：意图的主动作若不在变换注册表里（AI 未配置时 ai-* 动作
 *    根本没注册），整个意图作废——否则建议条会指向枢纽里不存在的卡片；
 *    同理，链只有**每一步**都在注册表里才能推（建议文案承诺的是“一次跑完”）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  suggestTop1,
  suggestSequence,
  suggestChain,
  suggestIntent,
  TOP1_MIN_SCORE,
  SEQUENCE_MIN_COUNT,
} from "@/lib/suggest";
import { __resetRecommendForTest, loadRecommendState } from "@/lib/recommend";
import { analyzeContent } from "@/lib/transforms/analyzer";
import { registerTransform, unregisterTransform } from "@/lib/transforms/registry";
import { loadUserChains, invalidateUserChains } from "@/lib/chains/registry";
import { detectIntent } from "@/lib/intent";
import type { ChainDef } from "@/lib/api/chains";
import type { Transform, TransformContext } from "@/lib/transforms/types";
// 触发内置变换注册（strip_html / mask-sensitive 等，suggestChain 依赖）。
// 注意：这里注册的**只有内置变换**，AI 动作（ai-*）是运行时从后端拉取后才注册的，
// 所以本测试文件的默认注册表状态 == 用户「AI 未配置」时的真实状态。
import "@/lib/transforms";

const JSON_TEXT = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]';

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

function w(actionId: string, contentType: string, count: number) {
  return { actionId, contentType, count };
}

beforeEach(() => {
  __resetRecommendForTest();
  vi.clearAllMocks();
});

describe("suggestTop1（单条 top-1）", () => {
  it("JSON 内容高匹配 → 返回 sql-in 建议", async () => {
    // 数据充足且常用 json-insert，使 recommendScored 首位稳定命中
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([w("json-insert", "json", 20)])
      .mockResolvedValueOnce([]) // action_recommend_scene_weights
      .mockResolvedValueOnce([]); // action_dismissals
    await loadRecommendState();

    const s = suggestTop1(ctx(JSON_TEXT, "json"));
    expect(s).not.toBeNull();
    if (!s || s.kind !== "action") throw new Error("应为 action 建议");
    expect(s.text).toBe(JSON_TEXT);
  });

  it("低匹配内容（普通一句话）→ null（不确定就不主动）", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // action_recommend_scene_weights
      .mockResolvedValueOnce([]); // action_dismissals
    await loadRecommendState();

    const s = suggestTop1(ctx("今天天气不错"));
    expect(s).toBeNull();
  });

  it("分数阈值是硬约束（常量写死防漂移）", () => {
    expect(TOP1_MIN_SCORE).toBe(0.75);
  });
});

describe("suggestSequence（序列识别）", () => {
  it("连续 3 个 IPv4 → SQL IN 合并建议", () => {
    const s = suggestSequence([
      { text: "192.168.1.1" },
      { text: "10.0.0.1" },
      { text: "8.8.8.8" },
    ]);
    expect(s).not.toBeNull();
    if (!s || s.kind !== "sequence") throw new Error("应为序列建议");
    expect(s.transformId).toBe("sql-in");
    // 合并输入是 JSON 数组，sql-in 可直接消费
    expect(JSON.parse(s.mergedText)).toEqual(["192.168.1.1", "10.0.0.1", "8.8.8.8"]);
  });

  it("连续 3 个邮箱 → SQL IN 合并建议", () => {
    const s = suggestSequence([
      { text: "a@b.com" },
      { text: "c@d.cn" },
      { text: "e@f.org" },
    ]);
    expect(s).not.toBeNull();
    if (!s || s.kind !== "sequence") throw new Error("应为序列建议");
    expect(s.transformId).toBe("sql-in");
  });

  it("不足 3 条 → null（数量下限）", () => {
    expect(suggestSequence([{ text: "1.1.1.1" }, { text: "2.2.2.2" }])).toBeNull();
    expect(suggestSequence([{ text: "1.1.1.1" }])).toBeNull();
    expect(suggestSequence([])).toBeNull();
  });

  it("混合类型 → null（同类才合并）", () => {
    const s = suggestSequence([
      { text: "192.168.1.1" },
      { text: "hello@world.com" },
      { text: "8.8.8.8" },
    ]);
    expect(s).toBeNull();
  });

  it("含空内容 → null", () => {
    expect(
      suggestSequence([{ text: "1.1.1.1" }, { text: "" }, { text: "8.8.8.8" }]),
    ).toBeNull();
  });

  it("数量下限常量防漂移", () => {
    expect(SEQUENCE_MIN_COUNT).toBe(3);
  });
});

describe("suggestChain（M4 跑链建议）", () => {
  it("含 HTML 标签的文本 → 建议「网页 → 纯文本」链", () => {
    const s = suggestChain(ctx("<p>Hello</p>\n<b>World</b>"));
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.kind).toBe("chain");
    if (s.kind === "chain") {
      expect(s.chainId).toBe("web-to-text");
      expect(s.stepCount).toBeGreaterThan(1);
    }
  });

  it("含手机号的内容 → 建议「敏感信息脱敏」链", () => {
    const s = suggestChain(ctx("联系我 13812345678 或者 13900001111"));
    expect(s).not.toBeNull();
    if (s?.kind === "chain") expect(s.chainId).toBe("mask-and-paste");
  });

  it("普通文本没有链命中 → null", () => {
    const s = suggestChain(ctx("今天天气不错，去吃个饭吧"));
    expect(s).toBeNull();
  });

  it("空文本 → null", () => {
    expect(suggestChain(ctx(""))).toBeNull();
  });
});

describe("suggestIntent（意图建议·注册表校验）", () => {
  /** 构造一个占位 AI 变换，用来模拟「AI 已配置、动作已在运行时注册进来」 */
  function fakeAiTransform(id: string, label: string): Transform {
    return {
      id,
      label,
      group: "text",
      detect: () => 0.9,
      run: () => ({ ok: true, output: "x" }),
    };
  }

  const ERR_TEXT = "Error: cannot find module 'react'\n  at webpack:///./src/main.tsx";

  it("主动作未注册（AI 未配置）→ null，而非把空诺言递给界面", () => {
    // 先确认规则层确实命中了意图（否则下面的 null 可能只是“本来就不命中”，测不到守卫）
    const raw = detectIntent(ctx(ERR_TEXT, "code"));
    expect(raw?.id).toBe("troubleshoot");
    expect(raw!.actionIds[0]).toBe("ai-explain-code");

    // 主动作 ai-explain-code 不在注册表 → 整个意图作废
    expect(suggestIntent(ctx(ERR_TEXT, "code"))).toBeNull();
  });

  it("JSON 对象意图的主动作是 ai-json-to-type → AI 未配置时也作废", () => {
    const raw = detectIntent(ctx('{"name":"x","age":1}', "json"));
    expect(raw!.actionIds[0]).toBe("ai-json-to-type");
    expect(suggestIntent(ctx('{"name":"x","age":1}', "json"))).toBeNull();
  });

  it("金额意图只有一个 AI 动作 → AI 未配置时作废", () => {
    expect(suggestIntent(ctx("A 项 ¥123.45，B 项 ¥678.90，合计约 ¥800"))).toBeNull();
  });

  it("主动作已注册（json_format）→ 正常返回意图", () => {
    const s = suggestIntent(ctx("[1,2,3]", "json"));
    expect(s).not.toBeNull();
    if (!s || s.kind !== "intent") throw new Error("应为意图建议");
    expect(s.intentId).toBe("json-shape");
    expect(s.actionIds[0]).toBe("json_format");
    expect(s.actionsText).toBe("格式化 → 转 SQL IN");
  });

  it("主动作已注册（sql-in）→ 批量意图不受守卫影响", () => {
    const s = suggestIntent(ctx("192.168.1.1\n192.168.1.2\n192.168.1.3"));
    expect(s).not.toBeNull();
    if (!s || s.kind !== "intent") throw new Error("应为意图建议");
    expect(s.intentId).toBe("batch");
    expect(s.actionIds[0]).toBe("sql-in");
  });

  it("备选动作缺失不影响意图，且**有意不过滤** actionIds（保持与 actionsText 一致）", () => {
    // collect-links：主动作 url-summary 是内置变换（已注册），备选 ai-summarize 未注册
    const s = suggestIntent(ctx("参考 https://docs.rs/rmcp 和 https://github.com/x/y 的文档"));
    expect(s).not.toBeNull();
    if (!s || s.kind !== "intent") throw new Error("应为意图建议");
    expect(s.intentId).toBe("collect-links");
    expect(s.actionIds[0]).toBe("url-summary");
    // 文案「链接摘要 → 总结」是手写整句，没法按 id 裁；那就一律不裁，
    // 宁可让 actionIds 与 actionsText 保持一致（下游两个组件只读 actionIds[0]）
    expect(s.actionIds).toContain("ai-summarize");
    expect(s.actionsText).toBe("链接摘要 → 总结");
  });

  it("AI 动作运行时注册进来后 → 同一内容重新给出意图（拦的是注册表，不是内容）", () => {
    registerTransform(fakeAiTransform("ai-explain-code", "解释代码"));
    try {
      const s = suggestIntent(ctx(ERR_TEXT, "code"));
      expect(s).not.toBeNull();
      if (!s || s.kind !== "intent") throw new Error("应为意图建议");
      expect(s.intentId).toBe("troubleshoot");
      expect(s.actionIds[0]).toBe("ai-explain-code");
      expect(s.actionsText).toBe("解释代码 → 提取要点");
    } finally {
      // 必须注销：注册表是模块级单例，泄露会污染同文件其他用例
      unregisterTransform("ai-explain-code");
    }
    // 注销后恢复「AI 未配置」行为
    expect(suggestIntent(ctx(ERR_TEXT, "code"))).toBeNull();
  });
});

describe("suggestChain（跑链建议·全步骤注册表校验）", () => {
  /** 含 HTML 标签的内容：strip_html（两条链的第一步）对它 detect 高分 */
  const HTML_TEXT = "<p>Hello</p>\n<b>World</b>";

  /** 自定义链的 id：它与预置 web-to-text 第一步相同，排在前面且比较是严格大于，
   *  所以只要它没被守卫拦下就一定胜出——这让「推/不推它」成为可观测的信号。 */
  const USER_CHAIN_ID = "user-html-then-ai";

  /** 占位 AI 变换（同上一个 describe）：模拟「AI 已配置、动作已运行时注册」 */
  function fakeAiTransform(id: string, label: string): Transform {
    return {
      id,
      label,
      group: "text",
      detect: () => 0.9,
      run: () => ({ ok: true, output: "x" }),
    };
  }

  /**
   * 向自定义链缓存里塞链。
   *
   * cachedUserChains() 只读模块级缓存、不触发加载，而缓存唯一的写入口是
   * loadUserChains()（内部走 chainList → invoke("chain_list")）。本文件已整体 mock
   * 了 invoke，所以直接塞一个返回值 + force 刷新就能把缓存填热。
   */
  async function seedUserChains(defs: ChainDef[]): Promise<void> {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(defs);
    await loadUserChains(true);
  }

  // 缓存是模块级单例，不清会污染后续用例（包括上面那组预置链断言）
  afterEach(() => {
    invalidateUserChains();
  });

  it("自定义链的第 2 步是未注册的 AI 动作 → 不推这条链", async () => {
    await seedUserChains([
      {
        id: USER_CHAIN_ID,
        name: "网页去标签后总结",
        description: "用户在 AI 可用时亲手建的链",
        steps: [
          { transformId: "strip_html", risk: "local" }, // 内置变换，已注册
          { transformId: "ai-summarize", risk: "network" }, // AI 未配置 → 不在注册表
        ],
      },
    ]);

    const s = suggestChain(ctx(HTML_TEXT));
    // 不是「一条链都不推」，而是「不推这条跑不完的链」：
    // 预置 web-to-text 全是本地步骤，应该顶上来
    expect(s?.kind).toBe("chain");
    if (s?.kind !== "chain") throw new Error("应为链建议");
    expect(s.chainId).not.toBe(USER_CHAIN_ID);
    expect(s.chainId).toBe("web-to-text");
  });

  it("同一条链的 AI 步骤被注册后 → 恢复推荐（拦的是注册表状态，不是链本身）", async () => {
    await seedUserChains([
      {
        id: USER_CHAIN_ID,
        name: "网页去标签后总结",
        description: "用户在 AI 可用时亲手建的链",
        steps: [
          { transformId: "strip_html", risk: "local" },
          { transformId: "ai-summarize", risk: "network" },
        ],
      },
    ]);

    // 先确认同一条链在 AI 未注册时确实不被推（否则下面的「恢复推荐」没有对照）
    const before = suggestChain(ctx(HTML_TEXT));
    if (before?.kind !== "chain") throw new Error("应为链建议");
    expect(before.chainId).not.toBe(USER_CHAIN_ID);

    registerTransform(fakeAiTransform("ai-summarize", "总结"));
    try {
      const s = suggestChain(ctx(HTML_TEXT));
      expect(s?.kind).toBe("chain");
      if (s?.kind !== "chain") throw new Error("应为链建议");
      expect(s.chainId).toBe(USER_CHAIN_ID);
      expect(s.stepCount).toBe(2);
    } finally {
      // 注册表是模块级单例，必须注销，否则污染其他用例
      unregisterTransform("ai-summarize");
    }
  });

  it("预置链（全本地步骤）不受影响，仍然能被推荐", () => {
    const s = suggestChain(ctx(HTML_TEXT));
    expect(s?.kind).toBe("chain");
    if (s?.kind !== "chain") throw new Error("应为链建议");
    expect(s.chainId).toBe("web-to-text");
    expect(s.stepCount).toBe(3); // strip_html → strip_lines → strip，三步全在注册表
  });

  it("自定义链全部步骤都是内置变换 → 正常推荐（证明守卫不是一刀切掉自定义链）", async () => {
    await seedUserChains([
      {
        id: "user-all-local",
        name: "去标签再修边",
        description: "全本地步骤的自定义链",
        steps: [
          { transformId: "strip_html", risk: "local" },
          { transformId: "strip", risk: "local" },
        ],
      },
    ]);

    const s = suggestChain(ctx(HTML_TEXT));
    expect(s?.kind).toBe("chain");
    if (s?.kind !== "chain") throw new Error("应为链建议");
    expect(s.chainId).toBe("user-all-local");
  });

  it("空步骤链不会报错，只是被跳过", async () => {
    // 自定义链来自后端表，不保证 steps 非空；旧代码 steps[0].transformId 会直接抛
    await seedUserChains([
      { id: "user-empty", name: "空链", description: "一步都没有", steps: [] },
    ]);

    expect(() => suggestChain(ctx(HTML_TEXT))).not.toThrow();
    const s = suggestChain(ctx(HTML_TEXT));
    if (s?.kind !== "chain") throw new Error("应为链建议");
    expect(s.chainId).toBe("web-to-text");
  });
});
