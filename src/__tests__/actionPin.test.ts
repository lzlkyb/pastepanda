/**
 * 常用置顶（v6.14）的前端行为。
 *
 * 这里盯的不是“置顶能不能存”（那是 Rust 侧四个测试的事），
 * 而是两个**容易静默退化的前提**：
 *
 * ① `isPinnedAction` 在未加载时必须返回 false——否则冷启动时会把排序打乱；
 * ② `matchQuickActions` 必须保持输入顺序——AiQuickBar 的置顶前置完全建立在这个前提上，
 *   它只取前 3 个，一旦它内部改成自己排序，置顶就会静默失效。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { isPinnedAction, __resetRecommendForTest } from "@/lib/recommend";
import { matchQuickActions } from "@/lib/aiQuick";

describe("isPinnedAction", () => {
  beforeEach(() => {
    __resetRecommendForTest();
  });

  it("未加载时返回 false（不打乱现有排序）", () => {
    expect(isPinnedAction("sql-in")).toBe(false);
    expect(isPinnedAction("不存在的动作")).toBe(false);
  });
});

describe("matchQuickActions 保序（AiQuickBar 置顶前置的前提）", () => {
  /** 造一个 AI 组候选项 */
  const ai = (id: string) => ({ id, label: id, group: "ai", remote: true });

  it("完全按输入顺序输出，不自己重排", () => {
    const out = matchQuickActions({
      text: "随便一段文字",
      aiOk: true,
      candidates: [ai("c"), ai("a"), ai("b")],
    });
    expect(out.map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("只取前 3 个——所以置顶必须在它之前前置，否则抢不到名额", () => {
    const out = matchQuickActions({
      text: "随便一段文字",
      aiOk: true,
      candidates: [ai("a"), ai("b"), ai("c"), ai("d"), ai("e")],
    });
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("把置顶项抬到前面后，它确实能进前 3", () => {
    const candidates = [ai("a"), ai("b"), ai("c"), ai("被置顶的")];
    // 模拟 AiQuickBar 里的稳定前置（只把置顶的抬头，组内不变）
    const pinned = new Set(["被置顶的"]);
    const ordered = [...candidates].sort(
      (x, y) => Number(pinned.has(y.id)) - Number(pinned.has(x.id)),
    );
    const out = matchQuickActions({ text: "x", aiOk: true, candidates: ordered });
    expect(out[0].id).toBe("被置顶的");
    // 组内原顺序保持（a 在 b 前）
    expect(out.map((a) => a.id)).toEqual(["被置顶的", "a", "b"]);
  });
});
