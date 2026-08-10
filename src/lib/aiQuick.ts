/**
 * lib/aiQuick.ts —— v6.4 主窗口 AI 感知（方案 B）：AI 快捷区的动作匹配规则。
 * 纯函数：按内容特征给出 2-3 个快捷动作（AI 动作 + 本地动作如粘贴脱敏）。
 * AI 是否可用由调用方传入（见 matchQuickActions 的 aiOk），这里不碰任何全局状态。
 */
import { maskSensitiveText } from "@/lib/mask";

export interface QuickAction {
  id: string;
  label: string;
  /**
   * true = 靠 AI 服务完成：会把内容发给第三方模型、按用量计费。
   * 两层含义捆在一起：既用于 AI 不可用时过滤，也用于界面把“这下会花钱”标出来（✦）。
   */
  ai: boolean;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;
const LINK_TYPE = "link";

/** 英文占比粗略判断（≥25% 的拉丁字母 token 视为英文内容） */
function isEnglishish(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const latin = words.filter((w) => /[A-Za-z]{2,}/.test(w)).length;
  return latin / words.length >= 0.25;
}

const ACTIONS = {
  // AI 可用时会走 ai-summarize 精炼（计费），所以算 AI 动作；
  // AI 不可用时它虽然能退回本地粗摘要，但那时整条快捷区（抬头就写着✦ AI）本身就不该出，
  // 需要它的人在变换面板里照样找得到（urlSummaryTransform 的 detect 不受 AI 门控）
  "url-summary": { id: "url-summary", label: "链接摘要", ai: true },
  "ai-translate": { id: "ai-translate", label: "翻译", ai: true },
  "ai-summarize": { id: "ai-summarize", label: "总结", ai: true },
  "ai-rewrite": { id: "ai-rewrite", label: "改写语气", ai: true },
  "ai-key-points": { id: "ai-key-points", label: "提取要点", ai: true },
  // 注册 id 是 mask-sensitive（勿改回 mask，否则 getTransform 找不到，按钮点了没反应）
  "mask-sensitive": { id: "mask-sensitive", label: "粘贴脱敏", ai: false },
} as const;

/**
 * 按内容匹配快捷动作（去重、最多 max 个）。
 *
 * `aiOk`（AI 是否可用）由调用方传进来（AiQuickBar 读 isAiAvailable()），不在这里直接调：
 * 一是保持纯函数、单测不必 mock 变换模块；二是 lib 层不依赖变换注册表的初始化时序。
 * **必须显式传**（不给默认值）：给了默认 true 就等于把这个坑重新埋回去。
 */
export function matchQuickActions(
  text: string,
  contentType: string,
  aiOk: boolean,
  max = 3,
): QuickAction[] {
  const t = (text || "").trim();
  if (!t) return [];
  const out: QuickAction[] = [];
  const push = (id: keyof typeof ACTIONS) => {
    if (!out.some((a) => a.id === id)) out.push(ACTIONS[id]);
  };

  const isLink = URL_RE.test(t) || contentType === LINK_TYPE;
  const sensitive = t.length > 0 && maskSensitiveText(t).count > 0;
  const english = isEnglishish(t);
  const long = t.length > 200;

  if (isLink) {
    push("url-summary");
    push("ai-summarize");
  } else if (sensitive) {
    push("mask-sensitive");
    push("ai-summarize");
  } else if (english) {
    push("ai-translate");
    push("ai-summarize");
    push("ai-rewrite");
  } else if (long) {
    push("ai-summarize");
    push("ai-rewrite");
    push("ai-key-points");
  } else {
    // 兜底：任何文本都能总结/改写
    push("ai-summarize");
    push("ai-rewrite");
  }

  // AI 不可用 → 一个 AI 动作也不给（否则就是摆一排点下去只会报错的按钮，
  // 而变换面板那边 scoreAiAction 首行就 return 0、一个都不推，两处必须一致）。
  // 过滤后只剩本地动作（如 mask-sensitive）或为空；为空时调用方据此整条不渲染。
  return out.filter((a) => aiOk || !a.ai).slice(0, max);
}
