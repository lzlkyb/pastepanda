/**
 * lib/nlActionParser.ts —— v6.3 自然语言动作路由（本地解析，零 AI 成本）。
 *
 * 把用户的一句话指令（「改得正式一点」「翻译成英文」「总结要点」）解析成
 * 已有变换动作 + 参数。**纯本地关键词规则**，不调 AI 判断——这正是
 * 「AI 只在本地规则拿不准时介入」哲学的本地侧：能规则化的，绝不上云。
 *
 * 门控（规则 15）：命中 AI 动作但未启用（isAiAvailable()=false）时，
 * 返回 `aiDisabled: true`，由 UI 提示先到设置启用——绝不静默失败或绕过开关。
 */
import { isAiAvailable } from "@/lib/transforms/aiTransforms";

/** 解析结果 */
export interface NlParseResult {
  /** 命中的动作 id；null = 没听懂 */
  actionId: string | null;
  /** 动作参数（如 tone=formal / lang=en） */
  params?: Record<string, string>;
  /** 人类可读的命中描述（如「改写为正式语气」） */
  label?: string;
  /** 命中 AI 动作但未启用（提示先配置 AI） */
  aiDisabled?: boolean;
}

// ===== 本地关键词规则 =====
// 顺序敏感：越具体的关键词越靠前（「翻译成英文」先命中语言，再命中泛「翻译」）

interface Rule {
  /** 命中关键词（子串匹配，已转小写） */
  keys: string[];
  actionId: string;
  /** 构造参数与文案；入参是**整句**（小写）——语言等信息可能出现在句子里别的位置 */
  build: (lowerInput: string) => { params?: Record<string, string>; label: string };
}

const LANG_MAP: Record<string, string> = {
  英文: "en", 英语: "en", 英文版: "en", 英文翻译: "en",
  日文: "ja", 日语: "ja", 日文版: "ja",
  韩文: "ko", 韩语: "ko",
  中文: "zh", 汉语: "zh", 中文版: "zh",
};

const RULES: Rule[] = [
  {
    // 改写语气
    keys: ["正式", "礼貌", "专业", "商务", "严肃", "庄重", "官腔"],
    actionId: "ai-rewrite",
    build: () => ({ params: { tone: "formal" }, label: "改写为正式语气" }),
  },
  {
    keys: ["简单", "通俗", "口语", "易懂", "直白", "接地气"],
    actionId: "ai-rewrite",
    build: () => ({ params: { tone: "casual" }, label: "改写为口语风格" }),
  },
  {
    keys: ["简洁", "简短", "精简", "压缩"],
    actionId: "ai-rewrite",
    build: () => ({ params: { tone: "concise" }, label: "改写为简洁版" }),
  },
  {
    // 翻译到指定语言（「翻译成英文」→ lang=en）
    keys: ["翻译成", "译成", "翻译为", "翻成", "用英语说", "用英文说", "用日语说", "用韩语说"],
    actionId: "ai-translate",
    build: (lowerInput) => {
      const langKey = Object.keys(LANG_MAP).find((k) => lowerInput.includes(k));
      const lang = (langKey && LANG_MAP[langKey]) || "en";
      const langLabel = Object.keys(LANG_MAP).find((k) => LANG_MAP[k] === lang) ?? lang;
      return { params: { lang }, label: `翻译成${langLabel}` };
    },
  },
  {
    // 通用翻译（「翻译一下」→ 默认英文；「翻译」出现在句尾也命中）
    keys: ["翻译", "translate"],
    actionId: "ai-translate",
    build: () => ({ params: { lang: "en" }, label: "翻译成英文" }),
  },
  {
    keys: ["总结", "摘要", "提炼", "要点", "概括", "浓缩"],
    actionId: "ai-summarize",
    build: () => ({ label: "总结要点" }),
  },
  {
    keys: ["解释", "讲解", "说明", "什么意思", "是什么", "看不懂", "教教我"],
    actionId: "ai-explain-code",
    build: () => ({ label: "解释这段内容" }),
  },
  {
    // 本地动作（不受 AI 门控）
    keys: ["sql in", "sql", "转成sql", "sql查询"],
    actionId: "sql-in",
    build: () => ({ label: "转成 SQL IN" }),
  },
];

/** 把一句话指令解析成动作。空输入/未命中 → actionId: null。 */
export function parseNlCommand(input: string): NlParseResult {
  const t = input.trim();
  if (!t) return { actionId: null };
  const lower = t.toLowerCase();

  for (const rule of RULES) {
    const matched = rule.keys.find((k) => lower.includes(k.toLowerCase()));
    if (!matched) continue;

    const { params, label } = rule.build(lower);
    const result: NlParseResult = { actionId: rule.actionId, params, label };

    // AI 门控（规则 15）：命中 AI 动作但未启用 → 标记 aiDisabled，由 UI 引导设置
    if (result.actionId!.startsWith("ai-") && !isAiAvailable()) {
      result.aiDisabled = true;
    }
    return result;
  }

  return { actionId: null };
}
