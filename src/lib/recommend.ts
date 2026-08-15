/**
 * lib/recommend.ts —— 个性化推荐（v6.1 从「推荐」到「记住」，v6.2 来源+时段感知）。
 *
 * 路线图公式：**最终排序 = detect() 静态分 × 个人使用频次权重 × 场景加成**。
 *
 * 设计取舍：
 * - **权重来自本地使用日志**（action_events），不出本机——这正是「本地优先」
 *   相对云端产品（Raycast 等）的结构性优势；
 * - **冷启动**：总事件数 < {@link MIN_EVENTS} 时完全不用权重，退回静态分。
 *   不能让新用户面对一个「还没学会」的排序；
 * - **负反馈**：「不再推荐这个」命中的 (动作, 内容类型) 直接**从排序里剔除**，
 *   contentType 为空 = 该动作在哪儿都不推荐。没有它推荐只会越来越吵；
 * - **场景加成（v6.2）**：按「时段桶（工作/晚间/深夜）× 来源类别（IDE/浏览器/终端/
 *   聊天/其他）」的频次做**乘法加成**。场景数据不足（< {@link SCENE_MIN_EVENTS}）时
 *   退化为 1（纯全局权重），不影响冷启动；
 * - **排序键加权、展示分不动**：权重只改变顺序，`score` 字段保持 detect 原始分。
 *
 * 权重数据在启动时（initBackend）加载；「不再推荐」触发后调
 * {@link refreshRecommendState} 即时生效。
 */
import {
  applicableTransforms,
  getTransform,
  type RecommendReason,
  type ScoredTransform,
  type TransformContext,
} from "@/lib/transforms";
import {
  actionDismissals,
  actionPins,
  actionRecommendSceneWeights,
  actionRecommendWeights,
  lastActionId,
  type ActionPin,
} from "@/lib/api/actionEvents";
import { sequenceTransitions, type SequenceTransition } from "@/lib/api/sequence";
import { aiFeedbackStats, type AiFeedbackStat } from "@/lib/api/aiFeedback";
import { contentTypeLabel } from "@/lib/actionLabels";
import { profileActionBoosts } from "@/lib/api/profile";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";

/** 冷启动阈值：总使用事件少于这个数就不应用权重（新用户前两周的数据量级） */
export const MIN_EVENTS = 20;

/** 学习强度：常用动作最多把排序键放大多少（1 + STRENGTH） */
export const STRENGTH = 1.5;

/** 场景数据不足阈值：某场景总次数低于它 → 场景加成为 1（纯全局权重） */
export const SCENE_MIN_EVENTS = 5;

/** v6.3 AI 兜底：本地规则最高分低于它（拿不准）时，把 AI 动作抬进推荐区 */
export const LOW_CONF_THRESHOLD = 0.5;

/** v6.3 AI 兜底：AI 动作被抬到的展示分（进推荐区 ≥0.6） */
export const AI_BOOST_SCORE = 0.6;

/**
 * 质量降权：样本不足 N 次的动作不参与。
 * 只有几次反馈时噪声太大——因一次不满意就把动作打入冷宫不公平。
 */
export const QUALITY_MIN_SAMPLES = 5;

/** 质量降权强度：完全不满意时最多打到 (1 - 强度) 折，不把动作彻底打死 */
export const QUALITY_STRENGTH = 0.5;

/**
 * 反馈统计窗口（天）。比权重窗口（14）宽是故意的：
 * 反馈事件比使用事件稀疏得多（只有 AI 动作产生，且要用户真的改/丢才计），
 * 14 天窗口下大部分动作到不了 QUALITY_MIN_SAMPLES 的门槛，降权形同虚设。
 */
export const FEEDBACK_DAYS = 30;

/**
 * 序列加成强度。**比 {@link STRENGTH}（1.5）弱一档是故意的。**
 *
 * 全局/场景权重是长期统计（两周的累积），而序列加成只在“10 分钟内刚做过某个动作”
 * 这个瞬时条件下生效，样本天然稀疏（只有连续操作才产生）。给到同等强度的话，
 * 一次偶然的连做就能反复主导整个排序。四个因子是**相乘**的，多一档强度
 * 就多一重放大，这里宁愿保守。
 */
export const SEQ_STRENGTH = 1.0;

/** 复合键：contentType \x00 actionId（\x00 分隔避免边界碰撞） */
const key = (ct: string, aid: string) => `${ct}\u0000${aid}`;

/** 场景键：contentType \x00 actionId \x00 hourBucket \x00 sourceCat */
const sceneKey = (ct: string, aid: string, hb: string, cat: string) =>
  `${ct}\u0000${aid}\u0000${hb}\u0000${cat}`;

/** 场景聚合键：hourBucket \x00 sourceCat（该场景总次数） */
const sceneTotalKey = (hb: string, cat: string) => `${hb}\u0000${cat}`;

/** 当前场景描述（与 Rust data_store::action_events 的 hour_bucket/source_cat 保持一致） */
export interface Scene {
  hourBucket: "work" | "evening" | "night";
  sourceCat: "ide" | "browser" | "terminal" | "chat" | "other";
}

/** 时段桶：工作时间（9-17）/ 晚间（18-23）/ 深夜-凌晨（0-8） */
export function hourBucketOf(hour: number): Scene["hourBucket"] {
  if (hour >= 9 && hour <= 17) return "work";
  if (hour >= 18 && hour <= 23) return "evening";
  return "night";
}

/** 来源应用（SOURCE_MAP 规范化后的 displayName）→ 类别（与 Rust source_cat 一致） */
export function sourceCatOf(app: string): Scene["sourceCat"] {
  const a = app.toLowerCase();
  const IDE = ["vscode", "visual studio", "code", "codebuddy", "idea", "jetbrains", "webstorm", "pycharm", "goland", "xcode"];
  const BROWSER = ["chrome", "edge", "firefox", "safari", "opera", "brave", "360", "qq浏览器", "浏览器"];
  const TERMINAL = ["terminal", "powershell", "cmd", "命令提示符", "conhost", "windowsterminal"];
  const CHAT = ["微信", "wechat", "企业微信", "wecom", "qq", "钉钉", "dingtalk", "telegram", "slack", "飞书"];
  if (IDE.some((k) => a.includes(k))) return "ide";
  if (BROWSER.some((k) => a.includes(k))) return "browser";
  if (TERMINAL.some((k) => a.includes(k))) return "terminal";
  if (CHAT.some((k) => a.includes(k))) return "chat";
  return "other";
}

/** 由当前小时 + 来源应用构造场景 */
export function sceneOf(hour: number, sourceApp: string): Scene {
  return { hourBucket: hourBucketOf(hour), sourceCat: sourceCatOf(sourceApp) };
}

// ===== 模块级缓存（启动时加载一次，刷新时替换） =====

let weights: Map<string, number> | null = null; // 复合键 -> 使用频次
let typeTotals: Map<string, number> | null = null; // contentType -> 该类型总使用次数
let sceneWeights: Map<string, number> | null = null; // 场景键 -> 使用频次（v6.2）
let sceneTotals: Map<string, number> | null = null; // 场景聚合键 -> 该场景总次数
let dismissals: Set<string> | null = null; // 复合键集合（含 "\u0000actionId" 全局项）
let totalEvents = 0;
/** 画像驱动推荐加成（v6.5）：actionId -> boost（角色 → 擅长动作） */
let roleBoosts: Map<string, number> | null = null;
/** 质量因子：actionId -> 乘数（产物老被改/被丢的动作 < 1）。未加载/样本不足 = 不在表里 */
let qualityFactors: Map<string, number> | null = null;
/**
 * 序列转移概率：“from\x00to” -> P(to|from)。
 *
 * 存概率而不是原始次数：徒次数没有可比性（常用动作的每一条转移都比冷门动作的大），
 * 而且与 global / scene 那两个因子的“占比归一化”写法对不上。
 */
let seqProbs: Map<string, number> | null = null;
/**
 * 常用置顶（v6.14）：用户显式标的“这个给我排前面”。本版只有全局置顶，所以只存 actionId。
 *
 * **它不参与乘法打分**（不像其他因子）：乘因子会被其它因子稀释，达不到“恒排最前”。
 * 置顶的语义是**分组前置**，由展示层（TransformHubDialog）拿 `isPinnedAction` 分组。
 */
let pinnedIds: Set<string> | null = null;
/** 画像加成缓存时间戳（画像变化慢，60s 缓存足够） */
let roleBoostsLoadedAt = 0;
/**
 * 画像加成的缓存有效期。
 * loadRecommendState 不只在启动跑：学习事件 debounce 后、打开托盘弹窗、
 * 点「不再推荐」都会再调一次，而画像是“角色 → 擅长动作”的慢变量，
 * 没必要每次都重拉。
 */
const ROLE_BOOSTS_TTL_MS = 60_000;

/** 推荐是否已就绪（未就绪 = 冷启动，走静态分） */
export function isRecommendReady(): boolean {
  return weights !== null && dismissals !== null;
}

/** 拉取权重 + 场景权重 + 负反馈 + 画像加成，替换模块级缓存。失败保持未加载状态（冷启动兜底）。 */
export async function loadRecommendState(): Promise<void> {
  try {
    // 命中 TTL 时不再发画像请求，用 null 占位表示“沿用上次的 roleBoosts”
    const reuseBoosts = roleBoosts !== null && Date.now() - roleBoostsLoadedAt < ROLE_BOOSTS_TTL_MS;
    const [rows, scenes, dis, boosts, feedback, transitions, pins] = await Promise.all([
      actionRecommendWeights(14),
      actionRecommendSceneWeights(14),
      actionDismissals(),
      reuseBoosts ? Promise.resolve(null) : profileActionBoosts().catch(() => []),
      // 反馈拉不到不影响推荐主链（降级为不降权），所以单独 catch
      aiFeedbackStats(FEEDBACK_DAYS).catch(() => [] as AiFeedbackStat[]),
      // 序列转移同理：拉不到就退化成没有序列加成，不能拖垂整个推荐
      sequenceTransitions().catch(() => [] as SequenceTransition[]),
      // 置顶同理：拉不到就当没置顶，不能把整个推荐拖死
      actionPins().catch(() => [] as ActionPin[]),
    ]);
    const w = new Map<string, number>();
    const totals = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      w.set(key(r.contentType, r.actionId), r.count);
      totals.set(r.contentType, (totals.get(r.contentType) ?? 0) + r.count);
      total += r.count;
    }
    const sw = new Map<string, number>();
    const st = new Map<string, number>();
    for (const r of scenes) {
      sw.set(sceneKey(r.contentType, r.actionId, r.hourBucket, r.sourceCat), r.count);
      const sk = sceneTotalKey(r.hourBucket, r.sourceCat);
      st.set(sk, (st.get(sk) ?? 0) + r.count);
    }
    weights = w;
    typeTotals = totals;
    sceneWeights = sw;
    sceneTotals = st;
    totalEvents = total;
    dismissals = new Set(dis.map((d) => key(d.contentType, d.actionId)));
    // 画像加成（独立于冷启动：画像只要有角色就有加成，哪怕行为事件少）
    if (boosts !== null) {
      roleBoosts = new Map(boosts.map((b) => [b.actionId, b.boost]));
      roleBoostsLoadedAt = Date.now();
    }
    // 质量因子：只收够样本量的，其余动作查表落空 → 1（不降权）
    qualityFactors = new Map(
      feedback
        .filter((s) => s.total >= QUALITY_MIN_SAMPLES)
        .map((s) => [s.actionId, computeQualityFactor(s)]),
    );
    seqProbs = buildSeqProbs(transitions);
    // 本版只有全局置顶，所以不看 contentType。将来按类型细化时这里要改成复合键。
    pinnedIds = new Set(pins.map((p) => p.actionId));
  } catch {
    weights = null;
    typeTotals = null;
    sceneWeights = null;
    sceneTotals = null;
    dismissals = null;
    totalEvents = 0;
    roleBoosts = null;
    roleBoostsLoadedAt = 0;
    qualityFactors = null;
    seqProbs = null;
    pinnedIds = null;
  }
}

/**
 * 转移次数 → 条件概率 P(to|from)。
 *
 * 分母是 **同一个 from 的所有转移之和**，而不是该动作的总使用次数：
 * 后端只返回 count ≥ 3 的转移，拿总使用次数当分母会把概率系统性压小
 * （分子被阈值截过、分母没有）。用可见转移的和作分母，它回答的是
 * “在你那些**稳定的**后续动作里，这个占多少”——正是排序需要的。
 */
export function buildSeqProbs(rows: SequenceTransition[]): Map<string, number> {
  const fromTotals = new Map<string, number>();
  for (const r of rows) {
    fromTotals.set(r.from, (fromTotals.get(r.from) ?? 0) + r.count);
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    const total = fromTotals.get(r.from) ?? 0;
    if (total > 0) out.set(key(r.from, r.to), r.count / total);
  }
  return out;
}

/**
 * 序列因子：“你刚做完 X，而你常在 X 之后做这个”。
 *
 * 三道门全部过了才加成：转移表已加载、上一个动作在 10 分钟内、该转移在表里。
 * 任一不满足返回 1（不影响现有排序）。
 */
export function seqFactorOf(actionId: string, prevId: string | null): number {
  if (!seqProbs || !prevId || prevId === actionId) return 1;
  const p = seqProbs.get(key(prevId, actionId));
  return p ? 1 + SEQ_STRENGTH * p : 1;
}

/** 手动刷新（「不再推荐」后调用，让负反馈立即生效） */
export async function refreshRecommendState(): Promise<void> {
  await loadRecommendState();
}

let learnListenerInstalled = false;
let learnDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 审查 #1（学习回流）：监听后端 `action-event-recorded`，debounce 500ms 后刷新权重。
 * 幂等（只装一次）；由 App 挂载时调用，让"用了 → 权重变 → 建议变"会话内可见。
 */
export function initLearnListener(): void {
  if (learnListenerInstalled) return;
  learnListenerInstalled = true;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("action-event-recorded", () => {
        if (learnDebounceTimer) clearTimeout(learnDebounceTimer);
        learnDebounceTimer = setTimeout(() => {
          void loadRecommendState().catch(() => {});
        }, 500);
      }),
    )
    .catch(() => {});
}

/** 画像角色加成因子（1 + boost）。画像未加载时 = 1（不影响现有排序）。 */
export function roleFactorOf(actionId: string): number {
  return 1 + (roleBoosts?.get(actionId) ?? 0);
}

/**
 * 单条反馈统计 → 质量乘数（≤ 1）。
 *
 * **不满意度是加权的，不是直接用 `editRate`**：outcome 有三态——
 * `edited`（改了才用）是**部分**不满意，`rejected`（重跑/丢弃）是**完全**不满意，
 * 两者权重不该相同。只看 editRate 会把 rejected 这个更强的信号整个漏掉。
 *
 * 样本不足返回 1（不参与排序）。
 */
export function computeQualityFactor(s: AiFeedbackStat): number {
  if (s.total < QUALITY_MIN_SAMPLES) return 1;
  const dissatisfied = (s.edited * 0.5 + s.rejected) / s.total;
  return 1 - Math.min(1, dissatisfied) * QUALITY_STRENGTH;
}

/** 质量降权因子（≤ 1）。未加载 / 样本不足 = 1（不影响现有排序）。 */
export function qualityFactorOf(actionId: string): number {
  return qualityFactors?.get(actionId) ?? 1;
}

/**
 * 该动作是否被用户置顶（v6.14）。
 *
 * 置顶**不进打分公式**，而是给展示层做分组用：置顶组整体排在推荐组之前。
 * 理由见 `pinnedIds` 的注释——乘因子会被稀释，做不到“恒排最前”。
 *
 * 未加载时返回 false：不置顶任何东西，也就不会打乱现有排序
 * （与其他因子的“未加载 = 不影响现有排序”一致）。
 */
export function isPinnedAction(actionId: string): boolean {
  return pinnedIds?.has(actionId) ?? false;
}

/** 仅供测试：重置模块状态 */
export function __resetRecommendForTest(): void {
  weights = null;
  typeTotals = null;
  sceneWeights = null;
  sceneTotals = null;
  dismissals = null;
  totalEvents = 0;
  roleBoosts = null;
  roleBoostsLoadedAt = 0;
  qualityFactors = null;
  seqProbs = null;
  pinnedIds = null;
}

// ===== 排序 =====

/**
 * 个性化推荐入口：applicableTransforms + 权重排序 + 场景加成 + 负反馈剔除。
 *
 * - 冷启动（数据不足/未加载）：返回静态排序，与 v6.0 行为一致；
 * - 否则：剔除负反馈命中的动作，按 detect × 全局权重 × 场景加成降序。
 * - `scene` 可选：提供「当前小时 + 来源应用」时启用场景加成；不提供则只有全局权重。
 */
export function recommendScored(
  ctx: TransformContext,
  scene?: Scene,
): ScoredTransform[] {
  const base = applicableTransforms(ctx);

  // v6.3 AI 兜底（**独立于冷启动**——新用户没数据时同样该生效）：
  // 本地规则全低分（< LOW_CONF_THRESHOLD）且内容非代码/结构化且 AI 可用时，
  // 把 AI 动作抬进推荐区（展示分提到 AI_BOOST_SCORE）——本地规则拿不准，AI 最可能有用。
  // 这只是展示调整，零调用零费用（规则 15：aiAvailable 门控）。
  const ct = ctx.contentType;
  const isCodeish = ct === "code" || ct === "json" || ct === "config";
  if (isAiAvailable() && !isCodeish) {
    const maxLocal = Math.max(
      0,
      ...base.map((s) => (s.transform.remote ? 0 : s.score)),
    );
    if (maxLocal < LOW_CONF_THRESHOLD) {
      for (const s of base) {
        if (s.transform.remote && s.score > 0) s.score = Math.max(s.score, AI_BOOST_SCORE);
      }
    }
  }

  if (!weights || !dismissals || totalEvents < MIN_EVENTS) return base;
  // 局部收窄：闭包回调里 TS 无法保证模块变量非 null
  const wts = weights;
  const swts = sceneWeights;
  const sts = sceneTotals;
  const dis = dismissals;

  const typeTotal = typeTotals?.get(ct) ?? 0;
  // 场景数据不足（< SCENE_MIN_EVENTS）→ 场景加成为空（退化为纯全局权重）
  const sceneTotal = scene
    ? (sts?.get(sceneTotalKey(scene.hourBucket, scene.sourceCat)) ?? 0)
    : 0;
  const useScene = scene !== undefined && sceneTotal >= SCENE_MIN_EVENTS;

  const filtered = base.filter(
    (s) =>
      !dis.has(key(ct, s.transform.id)) &&
      !dis.has(key("", s.transform.id)),
  );

  // 上一个动作整个排序共用一份：它带时间判定，逐条取的话理论上可能在同一次排序中途过期，
  // 产生“前半段有序列加成、后半段没有”的不一致排序。
  const prevId = lastActionId();

  // 因子只算一次：原来写在比较函数里，每次比较都重算一遍（O(n log n) 次）
  const withFactors = filtered.map((s) => {
    const f = factorsOf(s, wts, swts, typeTotal, sceneTotal, ct, scene, useScene, prevId);
    return { s, f, k: orderKeyOf(s.score, f) };
  });
  withFactors.sort((a, b) => b.k - a.k);

  // 排完序再挂理由：理由是给人看的，不参与排序，也不应该影响排序性能
  return withFactors.map(({ s, f }) => {
    const reason = explainReason(f, ct, useScene ? scene : undefined);
    return reason ? { ...s, reason } : s;
  });
}

/** 一个动作的各项因子（排序与理由共用同一份，避免两处各算一遍又算法不一致） */
interface Factors {
  global: number;
  scene: number;
  sequence: number;
  role: number;
  quality: number;
  /** 该内容类型下的使用次数（理由文案要用：“用过 12 次”） */
  count: number;
  /** 触发序列加成的上一个动作 id（理由文案要用：“你常在「X」之后…”） */
  prevId: string | null;
}

function factorsOf(
  s: ScoredTransform,
  wts: Map<string, number>,
  swts: Map<string, number> | null,
  typeTotal: number,
  sceneTotal: number,
  ct: string,
  scene: Scene | undefined,
  useScene: boolean,
  prevId: string | null,
): Factors {
  const count = wts.get(key(ct, s.transform.id)) ?? 0;
  const global = typeTotal > 0 ? 1 + STRENGTH * (count / typeTotal) : 1;

  // 场景加成：该动作在「当前时段 × 当前来源」的频次占比
  let sceneF = 1;
  if (useScene && scene && swts) {
    const sc = swts.get(sceneKey(ct, s.transform.id, scene.hourBucket, scene.sourceCat)) ?? 0;
    sceneF = sceneTotal > 0 ? 1 + STRENGTH * (sc / sceneTotal) : 1;
  }

  return {
    global,
    scene: sceneF,
    // 序列因子不归进 scene：那是“你在这个时段/这个应用里常用”（长期环境），
    // 这是“你刚才做了什么”（瞬时上下文），两者会同时成立也会各自成立
    sequence: seqFactorOf(s.transform.id, prevId),
    // 质量因子独立成一项，不塞进 role：那是“角色擅不擅长”，这是“产物好不好”
    role: roleFactorOf(s.transform.id),
    quality: qualityFactorOf(s.transform.id),
    count,
    prevId,
  };
}

/** 五因子相乘得排序键（展示分 × 各乘数） */
function orderKeyOf(score: number, f: Factors): number {
  return score * f.global * f.scene * f.sequence * f.role * f.quality;
}

/** 因子偏离 1 超过它才值得说一句——不然满屏都是“因为你用过 1 次”的废话 */
const REASON_MIN_DEVIATION = 0.12;
/** 使用次数低于它不拿来当理由（一两次不构成“常用”） */
const REASON_MIN_COUNT = 3;

/** 场景理由文案：来源比时段具体，有来源就优先说来源 */
function sceneText(scene: Scene): string {
  switch (scene.sourceCat) {
    case "ide": return "你在编辑器里常用";
    case "browser": return "你在浏览器里常用";
    case "terminal": return "你在终端里常用";
    case "chat": return "你在聊天窗口常用";
    default: return "你这个时段常用";
  }
}

/**
 * 选出“为什么排这里”的**主导因子**，生成一句人话。
 *
 * 规则：
 * - 只说**偏离 1 最多**的那一个，不堆叠——三行理由等于没有理由；
 * - 偏离不足 {@link REASON_MIN_DEVIATION} 一律不说；
 * - 质量降权是**负面**理由，但照样参与比较：它解释的是“为什么被往后排”，
 *   这是质量降权唯一能被用户看见的地方——不说它就是个黑箱。
 */
export function explainReason(
  f: Factors,
  ct: string,
  scene?: Scene,
): RecommendReason | undefined {
  const cands: { kind: RecommendReason["kind"]; dev: number; text: string }[] = [];

  if (f.count >= REASON_MIN_COUNT) {
    cands.push({
      kind: "usage",
      dev: f.global - 1,
      text: `你对${contentTypeLabel(ct)}用过 ${f.count} 次`,
    });
  }
  if (scene) {
    cands.push({ kind: "scene", dev: f.scene - 1, text: sceneText(scene) });
  }
  // 序列理由要能说出“在哪个动作之后”才有意义——光说“你常接着做这个”等于没说。
  // 拿不到上一个动作的名字（自定义动作被删、注册表未就绪）就干脆不参选。
  if (f.prevId) {
    const prevLabel = getTransform(f.prevId)?.label;
    if (prevLabel) {
      cands.push({
        kind: "sequence",
        dev: f.sequence - 1,
        text: `你常在「${prevLabel}」之后做这个`,
      });
    }
  }
  cands.push({ kind: "role", dev: f.role - 1, text: "常用于你这类工作" });
  cands.push({ kind: "quality", dev: 1 - f.quality, text: "产物常被你修改，已往后排" });

  const best = cands.reduce((a, b) => (b.dev > a.dev ? b : a));
  if (best.dev < REASON_MIN_DEVIATION) return undefined;
  return { kind: best.kind, text: best.text };
}

/** 某内容类型的总使用次数（供 UI 判断学习程度，如「学了 37 次」） */
export function recommendTotalEvents(): number {
  return totalEvents;
}
