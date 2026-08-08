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
import {
  aiGetConfig,
  aiHasKey,
  aiListActions,
  aiListCustomActions,
  aiListProviders,
  aiRun,
  type AiActionMeta,
  type AiCustomAction,
} from "@/lib/api/ai";

/**
 * AI 是否可用（总开关开着 + 已配置密钥）。
 *
 * `detect()` 是同步的，拿不到异步状态，所以缓在模块层。
 * 未配置时所有 AI 动作打 0 分 → 根本不会出现在界面上，
 * 而不是摆一排点下去才报错的按钮。
 */
let aiAvailable = false;

export function isAiAvailable(): boolean {
  return aiAvailable;
}

/** 仅供初始化与测试使用 */
export function setAiAvailable(value: boolean): void {
  aiAvailable = value;
}

/**
 * 各动作的匹配度打分。导出仅为了单测能直接验。
 *
 * 打分只看预分析好的 `features`，不重复解析文本。
 */
export function scoreAiAction(actionId: string, ctx: TransformContext): number {
  if (!aiAvailable) return 0;

  const stats = ctx.features?.stats;
  const len = stats?.length ?? ctx.text.trim().length;
  const type = ctx.contentType;
  // 代码/结构化数据不适合翻译和改写（会把标识符一并改掉）
  const isCodeish = type === "code" || type === "json" || type === "config";

  switch (actionId) {
    case "ai-translate":
      if (isCodeish || len < 10) return 0;
      // 成段的纯 ASCII 文字多半是外文，此时翻译最可能是用户想要的
      return stats?.hasUnicode === false ? 0.8 : 0.55;

    case "ai-summarize":
      // 短文本没什么可摘的，摆出来只会干扰选择
      return !isCodeish && len > 200 ? 0.7 : 0;

    case "ai-explain-code":
      if (type === "code") return 0.85;
      if (ctx.features?.sql) return 0.6;
      return 0;

    case "ai-rewrite":
      return !isCodeish && len >= 50 ? 0.5 : 0;

    default:
      return 0;
  }
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
  if (!aiAvailable) return 0;
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
    // opts 里混着枢纽传的非动作字段（如 html / force），只挑字符串选项送给后端
    const actionOpts: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts ?? {})) {
      if (k === "force" || k === "html") continue;
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
            message: `今日 AI 花费已达上限（约 ¥${r.spentCny.toFixed(2)} / ¥${r.budgetCny.toFixed(2)}），可在设置 → AI 里调高`,
            meta: {
              budgetExceeded: true,
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
    detect: (ctx) =>
      HAND_TUNED.has(meta.id)
        ? scoreAiAction(meta.id, ctx)
        : scoreByContentTypes(meta.contentTypes ?? [], ctx),
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
  actions.forEach((a) => registerTransform(toTransform(a)));
  await reloadAiCustomActions();
  await refreshAiAvailability();
}

/**
 * 重新判定 AI 是否可用。设置面板改完配置/密钥后要调，
 * 否则动作不会即时出现或消失。
 */
export async function refreshAiAvailability(): Promise<void> {
  try {
    const [cfg, hasKey, providers] = await Promise.all([
      aiGetConfig(),
      aiHasKey(),
      aiListProviders(),
    ]);
    // Ollama 这类本地厂商根本不要密钥，如果一律要求 hasKey，
    // 用户配好了也永远看不到 AI 动作
    const spec = providers.find((p) => p.id === cfg.provider);
    const keyOk = spec && !spec.needsKey ? true : hasKey;
    setAiAvailable(cfg.enabled && keyOk);
  } catch {
    setAiAvailable(false);
  }
}
