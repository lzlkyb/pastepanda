/**
 * lib/aiQuick.ts —— v6.4 主窗口 AI 感知（方案 B）：AI 快捷区的动作匹配规则。
 * 纯函数：按内容特征给出 2-3 个快捷动作（AI 动作 + 本地动作如脱敏/链接摘要）。
 */
import { maskSensitiveText } from "@/lib/mask";

export interface QuickAction {
  id: string;
  label: string;
  /** true = 走 AI（需 AI 服务）；false = 本地动作（脱敏/链接摘要，零成本） */
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
  "url-summary": { id: "url-summary", label: "链接摘要", ai: true }, // AI 可用时会走 ai-summarize 精炼（计费）
  "ai-translate": { id: "ai-translate", label: "翻译", ai: true },
  "ai-summarize": { id: "ai-summarize", label: "总结", ai: true },
  "ai-rewrite": { id: "ai-rewrite", label: "改写语气", ai: true },
  "ai-key-points": { id: "ai-key-points", label: "提取要点", ai: true },
  // 注册 id 是 mask-sensitive（勿改回 mask，否则 getTransform 找不到，按钮点了没反应）
  "mask-sensitive": { id: "mask-sensitive", label: "粘贴脱敏", ai: false },
} as const;

/** 按内容匹配快捷动作（去重、最多 MAX 个） */
export function matchQuickActions(
  text: string,
  contentType: string,
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

  return out.slice(0, max);
}
