/**
 * v6.2 主动建议模块测试。
 *
 * 约束重点：
 * 1. **不确定就不主动**：top-1 分数 < 阈值必须返回 null（"给列表说明你不确定"）；
 * 2. **序列识别只认同类**：3 个 IP / 3 个邮箱 → 合并建议；混合类型绝不建议；
 * 3. **数量下限**：不足 3 条同类不产生序列建议。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  suggestTop1,
  suggestSequence,
  suggestChain,
  TOP1_MIN_SCORE,
  SEQUENCE_MIN_COUNT,
} from "@/lib/suggest";
import { __resetRecommendForTest, loadRecommendState } from "@/lib/recommend";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";
// 触发内置变换注册（strip_html / mask-sensitive 等，suggestChain 依赖）
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
