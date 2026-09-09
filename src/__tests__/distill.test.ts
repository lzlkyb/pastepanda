import { describe, it, expect } from "vitest";
import {
  buildDailyDrafts,
  MAX_DRAFTS_PER_DAY,
  MIN_CLUSTER_SIZE,
  type DayExcerptRow,
} from "@/lib/notes/distill";

const D = "2026-09-08";

/** 造一条。`n` 只用来造不重复的 id。 */
function row(n: number, source: string, ct: string, excerpt = `摄录${n}`): DayExcerptRow {
  return {
    id: `h${n}`,
    time: `${D} 1${n % 10}:0${n % 10}:00`,
    source,
    type: "text",
    content_type: ct,
    excerpt,
  };
}

/** 造 k 条同一簇的。 */
function cluster(k: number, source: string, ct: string, base = 0): DayExcerptRow[] {
  return Array.from({ length: k }, (_, i) => row(base + i, source, ct));
}

describe("每日蒸馏·聚簇", () => {
  it("按「来源 × 类型」分簇，不同类型不归一篇", () => {
    const rows = [...cluster(3, "VS Code", "code", 0), ...cluster(3, "VS Code", "link", 10)];
    const d = buildDailyDrafts(rows, D);
    expect(d).toHaveLength(2);
    expect(new Set(d.map((x) => x.typeLabel)).size).toBe(2);
  });

  it(`不足 ${MIN_CLUSTER_SIZE} 条不成簇`, () => {
    // 两条不是「一串」，只是碰巧挨在一起；蒸馏的卖点是把散的收拢成一篇。
    expect(buildDailyDrafts(cluster(MIN_CLUSTER_SIZE - 1, "Chrome", "link"), D)).toHaveLength(0);
    expect(buildDailyDrafts(cluster(MIN_CLUSTER_SIZE, "Chrome", "link"), D)).toHaveLength(1);
  });

  it(`🔴 产出上限卡死在 ${MAX_DRAFTS_PER_DAY} 篇——这是防 Collector's Fallacy 的机制`, () => {
    // 造 6 个合格簇，只能出 3 篇。不限量的话，待沉淀就从「空」变成「刷不完」。
    const rows = Array.from({ length: 6 }, (_, i) => cluster(3, `App${i}`, "code", i * 10)).flat();
    expect(buildDailyDrafts(rows, D)).toHaveLength(MAX_DRAFTS_PER_DAY);
  });

  it("条数多的排前，同数时顺序稳定", () => {
    const rows = [
      ...cluster(3, "B 应用", "code", 0),
      ...cluster(5, "A 应用", "code", 10),
      ...cluster(3, "A 应用", "link", 20),
    ];
    const once = buildDailyDrafts(rows, D);
    expect(once[0].count).toBe(5);
    // 稳定性：不稳定的话每次刷新顶三篇都在跳
    expect(buildDailyDrafts(rows, D).map((x) => x.key)).toEqual(once.map((x) => x.key));
  });

  it("忽略过的簇不再出现", () => {
    const rows = cluster(3, "Chrome", "link");
    const [d] = buildDailyDrafts(rows, D);
    expect(buildDailyDrafts(rows, D, new Set([d.key]))).toHaveLength(0);
  });

  it("没摄录的条目不参与——否则拼出一堆空 bullet", () => {
    const rows = [
      ...cluster(2, "截图", "image"),
      { ...row(99, "截图", "image"), excerpt: "   " },
    ];
    // 去掉空摄录后只剩 2 条，不成簇
    expect(buildDailyDrafts(rows, D)).toHaveLength(0);
  });

  it("正文开头要说清楚这篇是怎么来的", () => {
    // 一篇只有 bullet 的笔记，三个月后想不起来当时为什么存它。
    const [d] = buildDailyDrafts(cluster(4, "Chrome", "link"), D);
    expect(d.content).toContain("Chrome");
    expect(d.content).toContain("4 条");
    expect(d.content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(4);
  });
});
