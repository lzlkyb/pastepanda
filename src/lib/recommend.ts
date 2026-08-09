/**
 * lib/recommend.ts —— 个性化推荐（v6.1：从「推荐」到「记住」）。
 *
 * 路线图公式：**最终排序 = detect() 静态分 × 个人使用频次权重**。
 *
 * 设计取舍：
 * - **权重来自本地使用日志**（action_events），不出本机——这正是「本地优先」
 *   相对云端产品（Raycast 等）的结构性优势；
 * - **冷启动**：总事件数 < {@link MIN_EVENTS} 时完全不用权重，退回静态分。
 *   不能让新用户面对一个「还没学会」的排序；
 * - **负反馈**：「不再推荐这个」命中的 (动作, 内容类型) 直接**从排序里剔除**，
 *   contentType 为空 = 该动作在哪儿都不推荐。没有它推荐只会越来越吵；
 * - **排序键加权、展示分不动**：权重只改变顺序，`score` 字段保持 detect 原始分，
 *   UI 上显示的百分比不会因此失真或超过 100%。
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
  actionRecommendWeights,
} from "@/lib/api/actionEvents";

/** 冷启动阈值：总使用事件少于这个数就不应用权重（新用户前两周的数据量级） */
export const MIN_EVENTS = 20;

/** 学习强度：常用动作最多把排序键放大多少（1 + STRENGTH） */
export const STRENGTH = 1.5;

/** 复合键：contentType \x00 actionId（\x00 分隔避免边界碰撞） */
const key = (ct: string, aid: string) => `${ct}\u0000${aid}`;

// ===== 模块级缓存（启动时加载一次，刷新时替换） =====

let weights: Map<string, number> | null = null; // 复合键 -> 使用频次
let typeTotals: Map<string, number> | null = null; // contentType -> 该类型总使用次数
let dismissals: Set<string> | null = null; // 复合键集合（含 "\u0000actionId" 全局项）
let totalEvents = 0;

/** 推荐是否已就绪（未就绪 = 冷启动，走静态分） */
export function isRecommendReady(): boolean {
  return weights !== null && dismissals !== null;
}

/** 拉取权重 + 负反馈，替换模块级缓存。失败保持未加载状态（冷启动兜底）。 */
export async function loadRecommendState(): Promise<void> {
  try {
    const [rows, dis] = await Promise.all([
      actionRecommendWeights(14),
      actionDismissals(),
    ]);
    const w = new Map<string, number>();
    const totals = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      w.set(key(r.contentType, r.actionId), r.count);
      totals.set(r.contentType, (totals.get(r.contentType) ?? 0) + r.count);
      total += r.count;
    }
    weights = w;
    typeTotals = totals;
    totalEvents = total;
    dismissals = new Set(dis.map((d) => key(d.contentType, d.actionId)));
  } catch {
    weights = null;
    typeTotals = null;
    dismissals = null;
    totalEvents = 0;
  }
}

/** 手动刷新（「不再推荐」后调用，让负反馈立即生效） */
export async function refreshRecommendState(): Promise<void> {
  await loadRecommendState();
}

/** 仅供测试：重置模块状态 */
export function __resetRecommendForTest(): void {
  weights = null;
  typeTotals = null;
  dismissals = null;
  totalEvents = 0;
}

// ===== 排序 =====

/**
 * 个性化推荐入口：applicableTransforms + 权重排序 + 负反馈剔除。
 *
 * - 冷启动（数据不足/未加载）：返回静态排序，与 v6.0 行为一致；
 * - 否则：剔除负反馈命中的动作，按 detect × (1 + STRENGTH × 相对频次) 降序。
 */
export function recommendScored(ctx: TransformContext): ScoredTransform[] {
  const base = applicableTransforms(ctx);
  if (!weights || !dismissals || totalEvents < MIN_EVENTS) return base;
  // 局部收窄：闭包回调里 TS 无法保证模块变量非 null
  const wts = weights;
  const dis = dismissals;

  const ct = ctx.contentType;
  const typeTotal = typeTotals?.get(ct) ?? 0;

  return base
    .filter(
      (s) =>
        !dis.has(key(ct, s.transform.id)) &&
        !dis.has(key("", s.transform.id)),
    )
    .sort((a, b) => orderKey(b, wts, typeTotal, ct) - orderKey(a, wts, typeTotal, ct));
}

function orderKey(
  s: ScoredTransform,
  wts: Map<string, number>,
  typeTotal: number,
  ct: string,
): number {
  const count = wts.get(key(ct, s.transform.id)) ?? 0;
  const factor = typeTotal > 0 ? 1 + STRENGTH * (count / typeTotal) : 1;
  return s.score * factor;
}

/** 某内容类型的总使用次数（供 UI 判断学习程度，如「学了 37 次」） */
export function recommendTotalEvents(): number {
  return totalEvents;
}
