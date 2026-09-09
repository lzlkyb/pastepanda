import { describe, it, expect } from "vitest";
import {
  buildDailyDrafts,
  buildDistillPayload,
  buildTopicDrafts,
  parseDistillResult,
  topicClusters,
  tokenize,
  overlap,
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

describe("每日蒸馏·P2 跨天主题", () => {
  const mk = (n: number, day: string, text: string): DayExcerptRow => ({
    id: `t${n}`,
    time: `${day} 10:0${n % 10}:00`,
    source: "终端",
    type: "text",
    content_type: "code",
    excerpt: text,
  });

  it("🔴 只出跨天的簇——同一天的归 P1，不然 P2 就是 P1 加了几步", () => {
    const sameDay = [
      mk(1, "2026-09-08", "docker compose up 启动服务"),
      mk(2, "2026-09-08", "docker compose down 停止服务"),
      mk(3, "2026-09-08", "docker compose logs 看日志"),
    ];
    expect(buildTopicDrafts(sameDay)).toHaveLength(0);

    const across = [
      mk(1, "2026-09-06", "docker compose up 启动服务"),
      mk(2, "2026-09-07", "docker compose down 停止服务"),
      mk(3, "2026-09-08", "docker compose logs 看日志"),
    ];
    expect(buildTopicDrafts(across)).toHaveLength(1);
  });

  it("🔴 占位文本不参与——实测它会聚出 48 条/8 天的假簇", () => {
    // 图片卡片的 text 是 `[图片] 835x116` 这种占位串，彼此重叠度极高。
    // 那是「格式相同」不是「主题相同」，靠调阈值压是打补丁。
    const shots = [
      mk(1, "2026-09-06", "[图片] 835x116"),
      mk(2, "2026-09-07", "[图片] 835x118"),
      mk(3, "2026-09-08", "[图片] 835x120"),
      mk(4, "2026-09-08", "[图片] 836x116"),
    ];
    expect(topicClusters(shots)).toHaveLength(0);
  });

  it("不相干的东西不该被聚到一起", () => {
    const mixed = [
      mk(1, "2026-09-06", "今天的天气很好适合出门散步"),
      mk(2, "2026-09-07", "SELECT * FROM orders WHERE id = 3"),
      mk(3, "2026-09-08", "会议纪要：下周三评审"),
    ];
    expect(buildTopicDrafts(mixed)).toHaveLength(0);
  });

  it("标题取簇内最高频的词，且同样输入给同样标题", () => {
    const rows = [
      mk(1, "2026-09-06", "回收站 UI 的空态还没做"),
      mk(2, "2026-09-07", "回收站 UI 的恢复按钮"),
      mk(3, "2026-09-08", "回收站 UI 的批量删除"),
    ];
    const [a] = buildTopicDrafts(rows);
    expect(a.title).toContain("回收");
    expect(a.title).toContain("跨 3 天");
    expect(buildTopicDrafts(rows)[0].title).toBe(a.title);
  });

  it("重叠系数用 min 分母，不是 Jaccard", () => {
    // 一条命令 vs 一段长报错常常是同一件事的两面；
    // Jaccard 会被长的那边把分母撑大，判成不相关。
    const short = tokenize("npm run build");
    const long = tokenize("npm run build 失败了报错说找不到模块请检查依赖是否安装完整");
    expect(overlap(short, long)).toBeGreaterThan(0.5);
  });
});

describe("每日蒸馏·标题口径", () => {
  // 🔴 三张同尺寸的图扁在一起时，`835x116` 与 `图片` 同频，
  // 而同频按字典序——`'835x116'.localeCompare('图片') === -1`，
  // 标题会变成 `835x116`。P2 在入口挡过占位串，P1 曾经没挡。
  it("占位串不能定标题", () => {
    const rows = [
      row(1, "微信", "image", "[图片] 835x116"),
      row(2, "微信", "image", "[图片] 835x116"),
      row(3, "微信", "image", "[图片] 835x116"),
    ];
    const [d] = buildDailyDrafts(rows, D);
    expect(d.title).not.toContain("835x116");
  });

  it("全是占位串时退回类型名，不编一个出来", () => {
    const rows = [
      row(1, "截图", "image", "[图片] 12x34"),
      row(2, "截图", "image", "[图片] 56x78"),
      row(3, "截图", "image", "[图片] 90x12"),
    ];
    const [d] = buildDailyDrafts(rows, D);
    // 没取到有语义的词就用类型名（typeLabel），而不是随便拿一个数字串
    expect(d.title).not.toMatch(/\d+x\d+/);
    expect(d.title).toContain("截图");
  });
});

describe("每日蒸馏·P3 AI 成文", () => {
  it("载荷只由摘录拼成，一条一行带编号", () => {
    const rows = [
      row(1, "VS Code", "code", "回收站按钮点不动"),
      row(2, "VS Code", "code", "回收站清空要二次确认"),
      row(3, "VS Code", "code", "回收站空态没做"),
    ];
    const [d] = buildDailyDrafts(rows, D);
    const payload = buildDistillPayload(d);
    expect(payload).toContain("[1]");
    expect(payload).toContain("[3]");
    expect(payload).not.toContain("[4]");
    // 🔴 出网面积的回归阀：载荷里的每一行都得能在摘录里找到。
    // 哪天有人把它改成去取全文，这条先红
    for (const r of rows) expect(payload).toContain(r.excerpt);
  });

  it("模型守格式时拆出首行标题", () => {
    const r = parseDistillResult("# 回收站的三个遗留问题\n\n- 空态\n- 二次确认", "备用标题");
    expect(r.title).toBe("回收站的三个遗留问题");
    expect(r.content).toContain("二次确认");
    expect(r.content.startsWith("#")).toBe(false);
  });

  // 最要紧的一条：模型违反格式是**常态**，此时绝不能把一次
  // 已经花了钱的调用丢掉——宁可标题土一点
  it("模型不守格式时回退到聚类标题，一个字不丢", () => {
    const raw = "这三条都在说回收站：\n- 空态\n- 二次确认";
    const r = parseDistillResult(raw, "VS Code · 代码 · 2026-09-08");
    expect(r.title).toBe("VS Code · 代码 · 2026-09-08");
    expect(r.content).toBe(raw);
  });

  it("只有一行标题、没正文也不能把标题当正文", () => {
    const r = parseDistillResult("## 只有标题", "备用");
    expect(r.title).toBe("只有标题");
    expect(r.content).toBe("");
  });
});
