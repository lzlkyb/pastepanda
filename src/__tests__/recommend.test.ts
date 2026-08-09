/**
 * 个性化推荐（v6.1）单元测试。
 *
 * 重点盯三件事：
 * 1. **冷启动**：数据不足（< MIN_EVENTS）时完全退回静态分，不能给新用户一个
 *    "还没学会"的排序；
 * 2. **权重只改顺序、不动展示分**：score 字段保持 detect 原始分，UI 百分比不失真；
 * 3. **负反馈必须生效**：「不再推荐这个」命中的动作从排序里消失（含全局空类型）。
 *
 * 注意：测试统一用**本地变换**（sql-in / json-insert），不用 AI 动作——
 * AI 动作的 detect 依赖 aiAvailable 标志，测试环境默认关闭会导致它们根本不出现。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  recommendScored,
  loadRecommendState,
  __resetRecommendForTest,
  MIN_EVENTS,
  STRENGTH,
} from "@/lib/recommend";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

// sql-in / json-insert 只对 JSON 数组命中（extractArrayFromJson），单个对象不命中
const JSON_TEXT = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]';
// text 类型但内容仍是数组：analyzer 照样提取 arrayInfo，sql-in 可命中（用于"跨类型不受牵连"）
const ARRAY_AS_TEXT = JSON_TEXT;

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

/** 造权重行 */
function w(actionId: string, contentType: string, count: number) {
  return { actionId, contentType, count };
}

/** mock invoke：第一次调用返回权重，第二次返回负反馈 */
const weights = (
  rows: ReturnType<typeof w>[],
  dis: { actionId: string; contentType: string; createdAt: string }[] = [],
) => {
  (invoke as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(rows) // action_recommend_weights
    .mockResolvedValueOnce(dis); // action_dismissals
};

beforeEach(() => {
  __resetRecommendForTest();
  vi.clearAllMocks();
});

describe("冷启动", () => {
  it("数据不足（< MIN_EVENTS）时退回静态分，与 v6.0 行为一致", async () => {
    weights([w("sql-in", "json", 2), w("json-insert", "json", 1)]);
    await loadRecommendState();

    const { applicableTransforms } = await import("@/lib/transforms");
    const staticList = applicableTransforms(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    const personal = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(personal).toEqual(staticList);
  });

  it("加载失败也退回静态分（不抛错）", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    await loadRecommendState(); // 不应抛
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("个性化权重排序", () => {
  it("数据充足时，个人常用动作排到前面", async () => {
    // 21 次事件超过阈值；json 内容里 json-insert(20次) 远常用 sql-in(1次)
    // 注意：后端已按 (action_id, content_type) GROUP BY，同 key 只返回一行、count 是聚合值
    const rows = [w("json-insert", "json", 20), w("sql-in", "json", 1)];
    weights(rows);
    await loadRecommendState();

    const ids = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    // json-insert 权重放大 ~2.4 倍，应排到 sql-in 前面（静态下 sql-in 更靠前）
    expect(ids.indexOf("json-insert")).toBeLessThan(ids.indexOf("sql-in"));
  });

  it("权重只改顺序，score 展示分保持 detect 原始分", async () => {
    const rows = [w("json-insert", "json", 20), w("sql-in", "json", 1)];
    weights(rows);
    await loadRecommendState();

    const { applicableTransforms } = await import("@/lib/transforms");
    const staticList = applicableTransforms(ctx(JSON_TEXT, "json"));
    const personal = recommendScored(ctx(JSON_TEXT, "json"));
    for (const s of personal) {
      const stat = staticList.find((x) => x.transform.id === s.transform.id)!;
      expect(s.score).toBe(stat.score);
    }
  });
});

describe("负反馈（不再推荐这个）", () => {
  it("命中的 (动作, 内容类型) 从排序中剔除", async () => {
    const rows = [w("json-insert", "json", 20)];
    weights(rows, [{ actionId: "json-insert", contentType: "json", createdAt: "" }]);
    await loadRecommendState();

    const ids = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(ids).not.toContain("json-insert");
    // 其他动作不受牵连
    expect(ids).toContain("sql-in");
  });

  it("全局负反馈（空 content_type）在任意类型下都剔除", async () => {
    const rows = [w("json-insert", "json", 20)];
    weights(rows, [{ actionId: "json-insert", contentType: "", createdAt: "" }]);
    await loadRecommendState();

    const ids = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(ids).not.toContain("json-insert");
  });

  it("负反馈只影响指定类型，其他类型不受牵连", async () => {
    // sql-in 同时在 json 和 text(带数字) 内容命中；只在 json 类型 dismiss 它
    const rows = [w("sql-in", "json", 20), w("sql-in", "text", 20)];
    weights(rows, [{ actionId: "sql-in", contentType: "json", createdAt: "" }]);
    await loadRecommendState();

    const jsonIds = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(jsonIds).not.toContain("sql-in");

    const textIds = recommendScored(ctx(ARRAY_AS_TEXT, "text")).map(
      (s) => s.transform.id,
    );
    expect(textIds).toContain("sql-in");
  });
});

describe("参数健全性", () => {
  it("MIN_EVENTS 与 STRENGTH 是可调常量（写死以防魔法数漂移）", () => {
    expect(MIN_EVENTS).toBe(20);
    expect(STRENGTH).toBe(1.5);
  });
});
