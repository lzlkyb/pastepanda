/**
 * `healthIssueKinds` 的用例（N3 库体检）。
 *
 * 它看着只是几个三元表达式相加，但它同时决定了两件事：
 * 顶部条**出不出现**（返 0 就不出），以及上面写的那个数字。
 * 两处各算一遍就会出现「条出来了但写着 0 项」，所以它必须是唯一判据。
 */
import { describe, it, expect } from "vitest";
import {
  healthIssueKinds,
  hasUnfiledAi,
  UNFILED_AI_MIN,
  type KbHealth,
} from "@/lib/api/kbHealth";

function make(patch: Partial<KbHealth> = {}): KbHealth {
  return {
    broken_links: [],
    broken_count: 0,
    tag_dups: [],
    tag_dup_count: 0,
    title_dups: [],
    title_dup_count: 0,
    tiny_notes: [],
    tiny_count: 0,
    unfiled_ai: [],
    unfiled_ai_count: 0,
    stats: {
      note_count: 0,
      avg_len: 0,
      max_len: 0,
      tag_count: 0,
      link_count: 0,
      unfiled_count: 0,
    },
    ...patch,
  };
}

describe("healthIssueKinds", () => {
  it("全好的库 → 0（顶部条据此整条不出现）", () => {
    expect(healthIssueKinds(make())).toBe(0);
  });

  it("数的是类别不是条目：1 条断链 + 2 篇空笔记 = 2 项，不是 3", () => {
    expect(healthIssueKinds(make({ broken_count: 1, tiny_count: 2 }))).toBe(2);
  });

  it("同一类里再多条也只算一项", () => {
    expect(healthIssueKinds(make({ broken_count: 137 }))).toBe(1);
  });

  it("五类全中 → 5", () => {
    const h = make({
      broken_count: 1,
      tag_dup_count: 1,
      title_dup_count: 1,
      tiny_count: 1,
      unfiled_ai_count: UNFILED_AI_MIN,
    });
    expect(healthIssueKinds(h)).toBe(5);
  });

  it("只看计数不看明细数组：明细封顶 5 条，拿数组长度判会在封顶时静默出错", () => {
    // 构造一个「计数 > 0 但明细为空」的形态（后端不会这么返，
    // 但判据必须靠计数这件事要能被断言住）
    expect(healthIssueKinds(make({ tiny_count: 8, tiny_notes: [] }))).toBe(1);
  });
});

describe("hasUnfiledAi", () => {
  it("未分类总数再大也不算问题——那是「没用这个功能」，不是缺陷", () => {
    // 真库实测 96% 的笔记没有文件夹。它落在 stats.unfiled_count，只作统计。
    const h = make({ stats: { ...make().stats, unfiled_count: 26 } });
    expect(hasUnfiledAi(h)).toBe(false);
    expect(healthIssueKinds(h)).toBe(0);
  });

  it("AI 写的那一半要堆到门槛才算堆积", () => {
    // 门槛下：AI 刚写完、还没归类，是**进行中**，不是堆积。
    // 顶部条跟着 version 每次写入都重算，没门槛就会闪出中间态。
    expect(hasUnfiledAi(make({ unfiled_ai_count: UNFILED_AI_MIN - 1 }))).toBe(false);
    expect(hasUnfiledAi(make({ unfiled_ai_count: UNFILED_AI_MIN }))).toBe(true);
  });

  it("门槛与顶部条的数字必须同源：不能出现「条出来了、展开却多一行」", () => {
    const below = make({ unfiled_ai_count: UNFILED_AI_MIN - 1, broken_count: 1 });
    // 别的项撑着，条会出来；但这一行不该跟着出来
    expect(healthIssueKinds(below)).toBe(1);
    expect(hasUnfiledAi(below)).toBe(false);
  });
});
