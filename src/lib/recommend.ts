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
  type ScoredTransform,
  type TransformContext,
} from "@/lib/transforms";
import {
  actionDismissals,
  actionRecommendSceneWeights,
  actionRecommendWeights,
  type SceneWeightRow,
} from "@/lib/api/actionEvents";
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
/** 画像加成缓存时间戳（画像变化慢，60s 缓存足够） */
let roleBoostsLoadedAt = 0;

/** 推荐是否已就绪（未就绪 = 冷启动，走静态分） */
export function isRecommendReady(): boolean {
  return weights !== null && dismissals !== null;
}

/** 拉取权重 + 场景权重 + 负反馈 + 画像加成，替换模块级缓存。失败保持未加载状态（冷启动兜底）。 */
export async function loadRecommendState(): Promise<void> {
  try {
    const [rows, scenes, dis, boosts] = await Promise.all([
      actionRecommendWeights(14),
      actionRecommendSceneWeights(14),
      actionDismissals(),
      profileActionBoosts().catch(() => []),
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
    roleBoosts = new Map(boosts.map((b) => [b.actionId, b.boost]));
    roleBoostsLoadedAt = Date.now();
  } catch {
    weights = null;
    typeTotals = null;
    sceneWeights = null;
    sceneTotals = null;
    dismissals = null;
    totalEvents = 0;
    roleBoosts = null;
    roleBoostsLoadedAt = 0;
  }
}

/** 手动刷新（「不再推荐」后调用，让负反馈立即生效） */
export async function refreshRecommendState(): Promise<void> {
  await loadRecommendState();
}

/** 画像角色加成因子（1 + boost）。画像未加载时 = 1（不影响现有排序）。 */
export function roleFactorOf(actionId: string): number {
  return 1 + (roleBoosts?.get(actionId) ?? 0);
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

  return filtered.sort((a, b) =>
    orderKey(b, wts, swts, typeTotal, sceneTotal, ct, scene, useScene) -
    orderKey(a, wts, swts, typeTotal, sceneTotal, ct, scene, useScene),
  );
}

function orderKey(
  s: ScoredTransform,
  wts: Map<string, number>,
  swts: Map<string, number> | null,
  typeTotal: number,
  sceneTotal: number,
  ct: string,
  scene: Scene | undefined,
  useScene: boolean,
): number {
  const count = wts.get(key(ct, s.transform.id)) ?? 0;
  const globalFactor = typeTotal > 0 ? 1 + STRENGTH * (count / typeTotal) : 1;

  // 场景加成：该动作在「当前时段 × 当前来源」的频次占比
  let sceneFactor = 1;
  if (useScene && scene && swts) {
    const sc = swts.get(sceneKey(ct, s.transform.id, scene.hourBucket, scene.sourceCat)) ?? 0;
    sceneFactor = sceneTotal > 0 ? 1 + STRENGTH * (sc / sceneTotal) : 1;
  }

  return s.score * globalFactor * sceneFactor * roleFactorOf(s.transform.id);
}

/** 某内容类型的总使用次数（供 UI 判断学习程度，如「学了 37 次」） */
export function recommendTotalEvents(): number {
  return totalEvents;
}
