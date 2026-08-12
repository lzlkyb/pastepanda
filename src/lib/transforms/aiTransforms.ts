/**
 * transforms/aiTransforms.ts —— 把云端 AI 动作注册成普通变换。
 *
 * 这里不新建任何界面：变换中心已经在按匹配度推荐动作了，AI 只是多一个
 * `group: "ai"` 的分组，复用入口、排序、结果回写整套机制。
 *
 * **动作定义以后端为单一数据源**（项目规则 #11）。前端不另写一份 label 与选项清单，
 * 而是启动时从 `ai_list_actions` 拉回来现场构造，避免两边漂移。
 */

import { registerTransform, unregisterTransform } from "./registry";
import type { Transform, TransformContext, TransformResult } from "./types";
import { logger } from "@/lib/logger";
import { budgetExceededMessage } from "@/lib/aiBudgetMsg";
import {
  aiListActions,
  aiListCustomActions,
  aiRun,
  type AiActionMeta,
  type AiCustomAction,
} from "@/lib/api/ai";
import {
  getAiAvailability,
  refreshAiAvailability,
  setAiAvailabilityForTest,
} from "@/lib/aiAvailability";

/**
 * AI 是否可用（总开关开着 + 密钥配齐）。
 *
 * `detect()` 是同步的，拿不到异步状态，所以只能读缓存——但**缓存与判定都在
 * `@/lib/aiAvailability` 里只有一份**，本模块不再自己存一个并行标志（以前这里一份、
 * useAiStatus 一份，两套缓存算同一件事，就是胶囊撒谎的根因）。
 * 不可用时所有 AI 动作打 0 分 → 根本不会出现在界面上，
 * 而不是摆一排点下去才报错的按钮。
 */
export function isAiAvailable(): boolean {
  return getAiAvailability().status === "on";
}

/** 仅供初始化与测试使用（写的也是那份共享状态） */
export function setAiAvailable(value: boolean): void {
  setAiAvailabilityForTest(value ? "on" : "off");
}

// 判定实现已收口到 @/lib/aiAvailability，这里只转出，保持 transforms 一侧的导入路径不变
export { refreshAiAvailability };

/**
 * 各动作的匹配度打分。导出仅为了单测能直接验。
 *
 * 打分只看预分析好的 `features`，不重复解析文本。
 */
export function scoreAiAction(actionId: string, ctx: TransformContext): number {
  if (!isAiAvailable()) return 0;

  const stats = ctx.features?.stats;
  const len = stats?.length ?? ctx.text.trim().length;
  const type = ctx.contentType;
  // 代码/结构化数据不适合翻译和改写（会把标识符一并改掉）
  const isCodeish = type === "code" || type === "json" || type === "config";
  const lang = languageTag(ctx);

  switch (actionId) {
    case "ai-translate":
      if (isCodeish || len < 10) return 0;
      // 成段的纯 ASCII 文字多半是外文，此时翻译最可能是用户想要的
      return stats?.hasUnicode === false ? 0.8 : 0.55;

    case "ai-summarize":
      // 短文本没什么可摘的，摆出来只会干扰选择
      return !isCodeish && len > 200 ? 0.7 : 0;

    case "ai-explain-code":
      // 知道是哪门语言时再提一档：后端 prompt 会把语言写进去（见 build_prompt），
      // 输出质量差别很大，值得排在普通代码前面
      if (type === "code") return lang ? 0.95 : 0.85;
      if (lang === "SQL" || ctx.features?.sql) return 0.6;
      return 0;

    case "ai-rewrite":
      return !isCodeish && len >= 50 ? 0.5 : 0;

    default:
      return 0;
  }
}

/**
 * 后端 ContentClassifier 产出的**语言级**自动标签（content_classifier.rs 的 LANGUAGE_PROFILES）。
 *
 * 这是 content_type 给不了的粒度：content_type 到 `code` 就到顶了，
 * 判不出是 Rust 还是 Java。名字必须与后端的 label 逐字一致。
 */
const LANGUAGE_TAGS = new Set([
  "Python",
  "JavaScript",
  "TypeScript",
  "Rust",
  "Java",
  "Go",
  "SQL",
  "HTML",
  "CSS",
  "Shell",
]);

/** 取条目上的语言级自动标签（没有则 undefined）。导出仅为单测。 */
export function languageTag(ctx: TransformContext): string | undefined {
  return ctx.tags?.find((t) => t.source === "auto" && LANGUAGE_TAGS.has(t.name))?.name;
}

/**
 * 手工标签 → 该浮出哪个动作。
 *
 * 这几个动作靠的是**用户意图**，文本里根本判不出来（“这条是要回复的”、
 * “这条是周报素材”），所以在没有标签之前它们只能拿通用分、几乎永远排不上来。
 *
 * **这张表注定是低召回的启发式，没命中不算错**：中文标签名千变万化，所以故意做小。
 * 真正的意图信息走另一条路：标签名会随内容进 prompt（ai_tags_as_context）。
 * 所以不要往这里堆同义词——那就变成又一处硬编码的并行判断。
 */
const INTENT_TAG_RULES: Array<{ re: RegExp; actions: string[] }> = [
  { re: /回复|回信|待回/, actions: ["ai-reply-draft"] },
  { re: /周报|日报|月报|汇报/, actions: ["ai-weekly-report"] },
  { re: /提交|commit/i, actions: ["ai-commit-message"] },
];

/**
 * 标签带来的额外分数。
 *
 * **必须用 `Math.max` 叠到基础分上，不能把这几个动作塞进 HAND_TUNED**：
 * 那样它们会丢掉现有的 scoreByContentTypes 分数，没标签时直接从变换中心里消失。
 * 标签只能把动作往上提，绝不把已有分数压下去。
 */
export function tagBoost(actionId: string, ctx: TransformContext): number {
  // 与 scoreAiAction / scoreByContentTypes 同一道门控：不守的话 AI 不可用时
  // 标签会把动作推成正分，摆出一个点下去只会报错的按钮。
  if (!isAiAvailable()) return 0;
  const manual = ctx.tags?.filter((t) => t.source === "manual") ?? [];
  if (manual.length === 0) return 0;
  for (const rule of INTENT_TAG_RULES) {
    if (!rule.actions.includes(actionId)) continue;
    if (manual.some((t) => rule.re.test(t.name))) return 0.9;
  }
  return 0;
}

/** 上面那个 switch 里手调过规则的四个动作。其余全走通用打分 */
const HAND_TUNED = new Set([
  "ai-translate",
  "ai-summarize",
  "ai-explain-code",
  "ai-rewrite",
]);

/**
 * 通用打分：只看适用内容类型。给新增内置动作与自定义动作用。
 *
 * 不限类型的排得比内置手调规则靠后（0.45 < 翻译的 0.55）——
 * 否则一个“适用全部”的自定义动作会把真正对口的那个挤下去。
 */
export function scoreByContentTypes(types: string[], ctx: TransformContext): number {
  if (!isAiAvailable()) return 0;
  if (types.length === 0) return 0.45;
  return types.includes(ctx.contentType) ? 0.75 : 0;
}

/**
 * 把三态返回映射成变换结果。
 *
 * “需要确认”与“超预算”用 `meta` 标记而不是只给一句 message，
 * 因为界面需要对它们做不同处理（前者给个“仍然发送”按钮，后者引向设置）。
 */
function makeRun(actionId: string) {
  return async (
    text: string,
    opts?: Record<string, unknown>
  ): Promise<TransformResult> => {
    // 变换枢纽注入的控制字段（非动作选项，不送给后端）——显式列出，避免魔法数字式黑名单
    const CONTROL_FIELDS = new Set(["force", "html"]);
    const actionOpts: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts ?? {})) {
      if (CONTROL_FIELDS.has(k)) continue;
      if (typeof v === "string") actionOpts[k] = v;
    }
    const force = opts?.force === true;

    try {
      const r = await aiRun(actionId, text, actionOpts, force);
      switch (r.status) {
        case "ok":
          return {
            ok: true,
            output: r.content,
            meta: {
              cached: r.cached,
              model: r.model,
              promptTokens: r.promptTokens,
              completionTokens: r.completionTokens,
              truncated: r.truncated,
            },
          };
        case "needsConfirm":
          return { ok: false, message: r.reason, meta: { needsConfirm: true } };
        case "budgetExceeded":
          return {
            ok: false,
            // v6.9：内置免费额度不足 → 单独文案 + isQuota 标记（前端按钮分支：去签到/兑换）
            message: r.isQuota
              ? "免费额度已用完，签到或兑换后继续使用"
              : budgetExceededMessage(r.spentCny, r.budgetCny),
            meta: {
              budgetExceeded: true,
              isQuota: r.isQuota === true,
              spentCny: r.spentCny,
              budgetCny: r.budgetCny,
            },
          };
      }
    } catch (e) {
      return { ok: false, message: `${e}` };
    }
  };
}

/** 用后端返回的元信息构造一个变换 */
function toTransform(meta: AiActionMeta): Transform {
  return {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    icon: meta.icon,
    group: "ai",
    remote: true,
    detect: (ctx) => {
      const base = HAND_TUNED.has(meta.id)
        ? scoreAiAction(meta.id, ctx)
        : scoreByContentTypes(meta.contentTypes ?? [], ctx);
      // max 而不是相加：标签只能把动作往上提，不能压低已有分数
      return Math.max(base, tagBoost(meta.id, ctx));
    },
    run: makeRun(meta.id),
    options: meta.options.length
      ? meta.options.map((o) => ({
          key: o.key,
          label: o.label,
          values: o.values,
          default: o.default,
        }))
      : undefined,
  };
}

/** 把用户自定义的动作也造成变换。与内置同处一个列表、同一套排序 */
function toCustomTransform(a: AiCustomAction): Transform {
  return {
    id: a.id,
    label: a.name,
    description: a.description || "自定义动作",
    icon: a.icon || "sparkles",
    group: "ai",
    remote: true,
    detect: (ctx) => scoreByContentTypes(a.contentTypes, ctx),
    run: makeRun(a.id),
  };
}

/** 已注册的自定义动作 id，用来算出哪些需要注销 */
let registeredCustomIds: string[] = [];

/**
 * 重新同步自定义动作。新建/编辑/删除/改顺序后都要调。
 *
 * **删掉的与停用的必须真注销**：只重新注册不注销的话，旧的会一直留在表里，
 * 点下去报“未知的 AI 动作”。
 */
export async function reloadAiCustomActions(): Promise<void> {
  let list: AiCustomAction[];
  try {
    list = await aiListCustomActions();
  } catch (e) {
    logger.warn("加载自定义 AI 动作失败", e);
    return;
  }
  const active = list.filter((a) => a.enabled);
  const next = new Set(active.map((a) => a.id));
  registeredCustomIds.filter((id) => !next.has(id)).forEach(unregisterTransform);
  active.forEach((a) => registerTransform(toCustomTransform(a)));
  registeredCustomIds = [...next];
}

/**
 * 启动时拉取动作清单并注册。失败不影响其他功能——最多就是没有 AI 动作。
 */
export async function initAiTransforms(): Promise<void> {
  const actions = await aiListActions();
  // 后端返回形状不对时别直接 `actions.forEach` —— 那会抛
  // `TypeError: actions.forEach is not a function`，而调用方只 catch 成一条 warn，
  // 结果是“AI 分组整体消失”但日志里只有一句看不出原因的类型错误。
  // 测试日志里这条已经真实出现过。
  if (!Array.isArray(actions)) {
    throw new Error(`ai_list_actions 返回的不是数组（得到 ${typeof actions}）`);
  }
  actions.forEach((a) => registerTransform(toTransform(a)));
  await reloadAiCustomActions();
  await refreshAiAvailability();
}

