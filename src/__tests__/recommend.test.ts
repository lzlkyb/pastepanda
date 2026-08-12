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
  LOW_CONF_THRESHOLD,
  AI_BOOST_SCORE,
  computeQualityFactor,
  qualityFactorOf,
  QUALITY_MIN_SAMPLES,
  QUALITY_STRENGTH,
} from "@/lib/recommend";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
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

/** 造场景权重行 */
function sw(
  actionId: string,
  contentType: string,
  hourBucket: string,
  sourceCat: string,
  count: number,
) {
  return { actionId, contentType, hourBucket, sourceCat, count };
}

/**
 * mock invoke：按 `loadRecommendState` 里 Promise.all 的**顺序**逐个返回。
 *
 * **六个都得 mock**：少一个就会在 `undefined.catch()` 上同步抛 TypeError，
 * 被外层 try 接住后静默走进降级分支——测试会"通过"，但测的是冷启动
 * 而不是它以为在测的权重逻辑。（profile_action_boosts 之前就漏了。）
 */
const weights = (
  rows: ReturnType<typeof w>[],
  dis: { actionId: string; contentType: string; createdAt: string }[] = [],
  scenes: ReturnType<typeof sw>[] = [],
  boosts: { actionId: string; boost: number }[] = [],
  feedback: { actionId: string; total: number; accepted: number; edited: number; rejected: number; editRate: number }[] = [],
  transitions: { from: string; to: string; count: number }[] = [],
) => {
  (invoke as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(rows) // action_recommend_weights
    .mockResolvedValueOnce(scenes) // action_recommend_scene_weights
    .mockResolvedValueOnce(dis) // action_dismissals
    .mockResolvedValueOnce(boosts) // profile_action_boosts
    .mockResolvedValueOnce(feedback) // ai_feedback_stats
    .mockResolvedValueOnce(transitions); // sequence_transitions
};

beforeEach(() => {
  __resetRecommendForTest();
  setAiAvailable(false); // AI 兜底测试会临时开启，其他测试保持关闭（避免 AI 动作混入）
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

// ============================================================
// P1-4 序列接入推荐（环境智能）
//
// “你刚做完 A，而你常在 A 之后做 B” → B 往前排。
// sequence_memory 之前是个孤岛：只给 SequenceDiscover 用，不参与排序。
// ============================================================

describe("序列转移概率", () => {
  it("分母是同一 from 的转移之和，不是全表总和", async () => {
    const { buildSeqProbs } = await import("@/lib/recommend");
    const m = buildSeqProbs([
      { from: "a", to: "b", count: 6 },
      { from: "a", to: "c", count: 2 },
      // 另一个 from 的转移不得稀释 a 的概率
      { from: "x", to: "y", count: 100 },
    ]);
    expect(m.get("a b")).toBeCloseTo(0.75);
    expect(m.get("a c")).toBeCloseTo(0.25);
    expect(m.get("x y")).toBeCloseTo(1);
  });

  it("空转移表不报错，返回空映射", async () => {
    const { buildSeqProbs } = await import("@/lib/recommend");
    expect(buildSeqProbs([]).size).toBe(0);
  });
});

describe("序列因子排序", () => {
  it("刚做完 A 时，常接在 A 后面的动作被抬前", async () => {
    const { logActionEvent, __resetLastActionForTest } = await import("@/lib/api/actionEvents");
    __resetLastActionForTest();
    // 全局权重上 json-insert 略占优（不接序列时它应该在前）
    weights(
      [w("json-insert", "json", 12), w("sql-in", "json", 10)],
      [],
      [],
      [],
      [],
      // 但你总是在「格式化 JSON」之后做 sql-in
      [{ from: "json-format", to: "sql-in", count: 9 }],
    );
    await loadRecommendState();

    // 不带序列上下文：json-insert 在前
    const before = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(before.indexOf("json-insert")).toBeLessThan(before.indexOf("sql-in"));

    // 刚做完 json-format → sql-in 应该反超
    logActionEvent({
      actionId: "json-format",
      contentType: "json",
      sourceApp: "",
      hour: 10,
      outcome: "copied",
    });
    const after = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(after.indexOf("sql-in")).toBeLessThan(after.indexOf("json-insert"));

    __resetLastActionForTest();
  });

  it("paste 哨兵不能当上一个动作（否则每次粘贴都会把序列上下文冲掉）", async () => {
    const { logActionEvent, lastActionId, __resetLastActionForTest } = await import(
      "@/lib/api/actionEvents"
    );
    __resetLastActionForTest();
    logActionEvent({
      actionId: "json-format",
      contentType: "json",
      sourceApp: "",
      hour: 10,
      outcome: "copied",
    });
    expect(lastActionId()).toBe("json-format");

    // 紧接着一次粘贴：不能把 lastAction 冲成 "paste"
    logActionEvent({
      actionId: "paste",
      contentType: "json",
      sourceApp: "",
      hour: 10,
      outcome: "pasted",
      historyId: "h1",
    });
    expect(lastActionId()).toBe("json-format");
    __resetLastActionForTest();
  });

  it("没有上一个动作时序列因子为 1（不影响现有排序）", async () => {
    const { seqFactorOf, __resetRecommendForTest: reset } = await import("@/lib/recommend");
    reset();
    expect(seqFactorOf("sql-in", null)).toBe(1);
    // 自转移也不加成：刚做完的动作再推一次自己没意义
    expect(seqFactorOf("sql-in", "sql-in")).toBe(1);
  });

  it("SEQ_STRENGTH 比 STRENGTH 弱（瞬时上下文不该压过长期统计）", async () => {
    const { SEQ_STRENGTH } = await import("@/lib/recommend");
    expect(SEQ_STRENGTH).toBe(1.0);
    expect(SEQ_STRENGTH).toBeLessThan(STRENGTH);
  });
});

// ============================================================
// v6.2 场景感知（来源+时段）
// ============================================================

describe("hourBucketOf / sourceCatOf / sceneOf", () => {
  it("时段桶边界正确", async () => {
    const { hourBucketOf } = await import("@/lib/recommend");
    expect(hourBucketOf(10)).toBe("work");
    expect(hourBucketOf(17)).toBe("work");
    expect(hourBucketOf(18)).toBe("evening");
    expect(hourBucketOf(23)).toBe("evening");
    expect(hourBucketOf(0)).toBe("night");
    expect(hourBucketOf(8)).toBe("night");
  });

  it("来源类别归类正确", async () => {
    const { sourceCatOf } = await import("@/lib/recommend");
    expect(sourceCatOf("VS Code")).toBe("ide");
    expect(sourceCatOf("Chrome")).toBe("browser");
    expect(sourceCatOf("Terminal")).toBe("terminal");
    expect(sourceCatOf("微信")).toBe("chat");
    expect(sourceCatOf("未知应用")).toBe("other");
  });
});

describe("场景感知排序", () => {
  it("当前场景常用动作被加成排前（工作时间 IDE 偏工程）", async () => {
    // 全局接近：json-insert(11) 略常用；场景 work×ide 里 sql-in(18) 绝对主导
    const rows = [w("json-insert", "json", 11), w("sql-in", "json", 9)];
    const scenes = [
      sw("sql-in", "json", "work", "ide", 18),
      sw("json-insert", "json", "work", "ide", 1),
    ];
    weights(rows, [], scenes);
    await loadRecommendState();

    // 无场景：json-insert 排前（全局权重主导）
    const plain = recommendScored(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    expect(plain.indexOf("json-insert")).toBeLessThan(plain.indexOf("sql-in"));

    // 场景 work×ide：sql-in 被场景加成（18/19 占比）→ 反超
    const scened = recommendScored(ctx(JSON_TEXT, "json"), {
      hourBucket: "work",
      sourceCat: "ide",
    }).map((s) => s.transform.id);
    expect(scened.indexOf("sql-in")).toBeLessThan(scened.indexOf("json-insert"));
  });

  it("场景数据不足（< SCENE_MIN_EVENTS）→ 退化为纯全局权重", async () => {
    const rows = [w("json-insert", "json", 20), w("sql-in", "json", 1)];
    // 场景总次数只有 3（< 5）
    const scenes = [
      sw("sql-in", "json", "work", "ide", 2),
      sw("json-insert", "json", "work", "ide", 1),
    ];
    weights(rows, [], scenes);
    await loadRecommendState();

    const scened = recommendScored(ctx(JSON_TEXT, "json"), {
      hourBucket: "work",
      sourceCat: "ide",
    }).map((s) => s.transform.id);
    expect(scened.indexOf("json-insert")).toBeLessThan(scened.indexOf("sql-in"));
  });

  it("传入场景但全局数据不足 → 仍冷启动（静态分）", async () => {
    weights([w("json-insert", "json", 2)]);
    await loadRecommendState();

    const { applicableTransforms } = await import("@/lib/transforms");
    const staticList = applicableTransforms(ctx(JSON_TEXT, "json")).map((s) => s.transform.id);
    const scened = recommendScored(ctx(JSON_TEXT, "json"), {
      hourBucket: "work",
      sourceCat: "ide",
    }).map((s) => s.transform.id);
    expect(scened).toEqual(staticList);
  });
});

// ============================================================
// v6.3 AI 兜底：本地规则拿不准时，AI 动作抬进推荐区
// ============================================================

describe("AI 兜底（低置信提升）", () => {
  // AI 动作是运行时 initAiTransforms 注册的，测试环境不跑 → 手动注册一个 remote 动作模拟。
  // detect 也模拟真实 AI 动作的门控（aiAvailable=false 时返回 0，规则 15）。
  async function registerFakeAi() {
    const { registerTransform } = await import("@/lib/transforms");
    const { isAiAvailable } = await import("@/lib/transforms/aiTransforms");
    registerTransform({
      id: "ai-fake",
      label: "测试AI",
      group: "ai",
      remote: true,
      detect: () => (isAiAvailable() ? 0.55 : 0),
      run: async () => ({ ok: true, output: "x" }),
    } as never);
  }

  // 英文长句：本地动作最高 0.25（strip 系列），maxLocal < 0.5 → 触发兜底
  const PLAIN_EN =
    "The quick brown fox jumps over the lazy dog while the sun sets in the west.";

  it("AI 可用 + 非代码 + 本地全低分 → AI 动作抬到 AI_BOOST_SCORE", async () => {
    setAiAvailable(true);
    await registerFakeAi();
    weights([], []);
    await loadRecommendState();

    const list = recommendScored(ctx(PLAIN_EN));
    const ai = list.find((s) => s.transform.id === "ai-fake");
    expect(ai).toBeDefined();
    expect(ai!.score).toBeGreaterThanOrEqual(AI_BOOST_SCORE);
  });

  it("AI 不可用 → 不兜底（AI 动作 score=0 不可见）", async () => {
    setAiAvailable(false);
    await registerFakeAi();
    weights([], []);
    await loadRecommendState();

    const list = recommendScored(ctx(PLAIN_EN));
    expect(list.find((s) => s.transform.id === "ai-fake")).toBeUndefined();
  });

  it("代码/结构化内容 → 不兜底（本地规则明确，AI 不适合）", async () => {
    setAiAvailable(true);
    await registerFakeAi();
    weights([], []);
    await loadRecommendState();

    // json 内容：sql-in 等高置信本地动作存在，且 isCodeish 阻止兜底
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    const ai = list.find((s) => s.transform.id === "ai-fake");
    // isCodeish → 不兜底：ai-fake 保持 0.55（若出现）或 sql-in 高分在前
    if (ai) {
      expect(ai.score).toBeLessThan(AI_BOOST_SCORE);
    }
  });

  it("本地已有高分动作 → 不兜底（规则拿得准）", async () => {
    setAiAvailable(true);
    await registerFakeAi();
    weights([], []);
    await loadRecommendState();

    // 中文句子命中 unicode_encode 0.6（本地拿得准）→ 不兜底
    const list = recommendScored(ctx("这是一段普通的中文内容，讲的是今天发生的事情。"));
    const ai = list.find((s) => s.transform.id === "ai-fake");
    if (ai) {
      expect(ai.score).toBeLessThan(AI_BOOST_SCORE);
    }
  });

  it("阈值常量防漂移", () => {
    expect(LOW_CONF_THRESHOLD).toBe(0.5);
    expect(AI_BOOST_SCORE).toBe(0.6);
  });
});

/**
 * 质量降权：产物老被改/被丢的动作往后排。
 *
 * 背景：`edit_rate` 一直算着但一处没用——系统记录了用户的不满，却从不据此调整。
 */
describe("质量降权因子", () => {
  const stat = (total: number, edited: number, rejected: number) => ({
    actionId: "a",
    total,
    accepted: total - edited - rejected,
    edited,
    rejected,
    editRate: total > 0 ? edited / total : 0,
  });

  it("样本不足不参与（不因一两次不满意就打入冷宫）", () => {
    expect(computeQualityFactor(stat(QUALITY_MIN_SAMPLES - 1, 4, 0))).toBe(1);
  });

  it("全部满意 = 不降权", () => {
    expect(computeQualityFactor(stat(10, 0, 0))).toBe(1);
  });

  it("全部被丢弃 = 降到最低档（不把动作彻底打死）", () => {
    expect(computeQualityFactor(stat(10, 0, 10))).toBeCloseTo(1 - QUALITY_STRENGTH);
  });

  /**
   * 核心：为什么不能直接用 `editRate`。
   * 两条统计的 editRate 完全一样（都是 0），但一条全被丢弃、一条全被接受——
   * 只看 editRate 会把这两者当成同一回事。
   */
  it("rejected 是比 edited 更强的不满意信号", () => {
    const allRejected = stat(10, 0, 10);
    const allAccepted = stat(10, 0, 0);
    expect(allRejected.editRate).toBe(allAccepted.editRate); // editRate 看不出差别
    expect(computeQualityFactor(allRejected)).toBeLessThan(computeQualityFactor(allAccepted));

    // 同样数量：丢弃比改动罚得重
    expect(computeQualityFactor(stat(10, 0, 6))).toBeLessThan(computeQualityFactor(stat(10, 6, 0)));
  });

  it("未加载时因子为 1（不影响现有排序）", () => {
    __resetRecommendForTest();
    expect(qualityFactorOf("任意动作")).toBe(1);
  });

  it("只降有反馈的那个动作，不涉及其它", async () => {
    weights(
      [w("sql-in", "json", 10), w("json-insert", "json", 10)],
      [],
      [],
      [],
      [{ ...stat(10, 0, 10), actionId: "sql-in" }],
    );
    await loadRecommendState();
    expect(qualityFactorOf("sql-in")).toBeLessThan(1);
    expect(qualityFactorOf("json-insert")).toBe(1);
  });
});

/**
 * 推荐理由（“为什么排这里”）。
 *
 * 目的是信任：用户不知道推荐凭什么，就永远只敢拿它做能一眼验证的事。
 */
describe("推荐理由", () => {
  it("冷启动不给理由（没学到东西时假装懂你更损伤信任）", async () => {
    weights([w("sql-in", "json", 2)]); // 总量 < MIN_EVENTS
    await loadRecommendState();
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    expect(list.every((s) => s.reason === undefined)).toBe(true);
  });

  it("常用动作给出使用次数理由", async () => {
    weights([w("sql-in", "json", 30), w("json-insert", "json", 1)]);
    await loadRecommendState();
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    const top = list.find((s) => s.transform.id === "sql-in");
    expect(top?.reason?.kind).toBe("usage");
    expect(top?.reason?.text).toContain("30 次");
  });

  it("用过一两次不算理由", async () => {
    // 2 次 < REASON_MIN_COUNT（3），不能拿来当“你常用”
    weights([w("sql-in", "json", 2), w("json-insert", "json", 40)]);
    await loadRecommendState();
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    const low = list.find((s) => s.transform.id === "sql-in");
    expect(low?.reason?.kind).not.toBe("usage");
  });

  /**
   * 注意数据设计：sql-in 用得**少**（4/44）但产物全被丢。
   *
   * 如果反过来让它既常用又质量差（如 8/16），主导因子会是“你常用”而非负面理由——
   * 而且那是对的：1.75 × 0.5 = 0.875 仍高于不常用的动作，它根本没被往后排，
   * 此时说“已往后排”是撒谎。负面理由只在它真的被降下去时才该出现。
   */
  it("质量降权会给出负面理由（否则降权就是黑箱）", async () => {
    weights(
      [w("sql-in", "json", 4), w("json-insert", "json", 40)],
      [],
      [],
      [],
      [{ actionId: "sql-in", total: 10, accepted: 0, edited: 0, rejected: 10, editRate: 0 }],
    );
    await loadRecommendState();
    const list = recommendScored(ctx(JSON_TEXT, "json"));
    const bad = list.find((s) => s.transform.id === "sql-in");
    expect(bad?.reason?.kind).toBe("quality");
    expect(bad?.reason?.text).toContain("修改");
  });
});
