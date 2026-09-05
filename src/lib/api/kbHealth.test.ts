/**
 * `healthIssueKinds` 的用例（N3 库体检）。
 *
 * 它看着只是四个三元表达式相加，但它同时决定了两件事：
 * 顶部条**出不出现**（返 0 就不出），以及上面写的那个数字。
 * 两处各算一遍就会出现「条出来了但写着 0 项」，所以它必须是唯一判据。
 */
import { describe, it, expect } from "vitest";
import { healthIssueKinds, type KbHealth } from "@/lib/api/kbHealth";

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
    stats: { note_count: 0, avg_len: 0, max_len: 0, tag_count: 0, link_count: 0 },
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

  it("四类全中 → 4", () => {
    const h = make({
      broken_count: 1,
      tag_dup_count: 1,
      title_dup_count: 1,
      tiny_count: 1,
    });
    expect(healthIssueKinds(h)).toBe(4);
  });

  it("只看计数不看明细数组：明细封顶 5 条，拿数组长度判会在封顶时静默出错", () => {
    // 构造一个「计数 > 0 但明细为空」的形态（后端不会这么返，
    // 但判据必须靠计数这件事要能被断言住）
    expect(healthIssueKinds(make({ tiny_count: 8, tiny_notes: [] }))).toBe(1);
  });
});
