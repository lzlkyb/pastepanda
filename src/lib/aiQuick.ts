/**
 * lib/aiQuick.ts —— AI 快捷区的动作**取舍策略**。
 *
 * 它不再自己判内容。以前这里有一条 if/else 链（链接 / 脱敏 / 英文 / 长文 / 兜底），
 * 而变换中心那边的 `scoreAiAction` 在干同一件事——两套并行推荐逻辑，而这边那套是残缺的：
 *
 * - `contentType` 只被用来判一件事（是不是 link），而 content_type 共 18 种；
 * - 于是 **代码会被推「翻译」**：代码里 `function`/`const`/`return` 都是拉丁 token，
 *   isEnglishish 必然 ≥25%；而 `content_type === "code"` 明明已经识别出来了却没参与匹配。
 *   scoreAiAction 那边对这一点是对的（isCodeish 直接给翻译/改写/总结 0 分）。
 * - 后端注册了 16 个 AI 动作，这里只硬写了 5 个（ai-explain-code / ai-fix-code /
 *   ai-commit-message / ai-json-to-type / ai-tabulate / ai-sql-generate … 全漏了）。
 *
 * 现在打分全交给 `applicableTransforms()`（它会跑 analyzeContent 建 features、
 * 对每个变换调 detect、按分降序），**排好序的候选以参数传进来**。
 * 依赖注入而不是在这里 import 注册表，是为了：① 本模块仍是纯函数，单测不必
 * 初始化整个变换注册表；② lib 层不依赖注册表的初始化时序。
 *
 * 本模块只剩四件事：白名单（快捷栏不是第二个变换中心）、出网标记、
 * 短文本兜底、上限截断。
 */

import { looksLikeIdentifier } from "@/lib/utils";

export interface QuickAction {
  id: string;
  label: string;
  /**
   * true = 靠 AI 服务完成，或至少会把内容发到第三方（可能计费）。
   * 两层含义捆在一起：既用于 AI 不可用时过滤，也用于界面把「这下会花钱/出网」标出来（✦）。
   */
  ai: boolean;
}

/**
 * 候选动作：由调用方从 `applicableTransforms()` 的结果映射而来，
 * **已按匹配度降序**。只取需要的四个字段，不把整个 Transform（带 run/detect）拖进来。
 */
export interface QuickCandidate {
  id: string;
  label: string;
  group: string;
  /** Transform.remote：需要联网且可能计费 */
  remote?: boolean;
}

/**
 * 允许出现在快捷栏的**非 ai 分组**动作。
 *
 * 不能直接把 `applicableTransforms()` 的前三名摆上去——那里还有大小写转换、
 * base64、SQL 格式化等几十个，快捷栏不是第二个变换中心。只放两类：
 * - 与「刚复制完就想立即做」高度相关的本地零成本动作（脱敏、路径三件）；
 * - 链接摘要（group 是 web，但语义上属于 AI 能力）。
 */
const NON_AI_ALLOW = new Set([
  "mask-sensitive",
  "url-summary",
  // 图片/文件条目的路径支路用（本地、零成本、不出网）
  "path_name",
  "path_fslash",
  "path_bslash",
]);

/**
 * 会出网但既不在 ai 分组、也没标 `remote: true` 的动作。
 *
 * `url-summary` 会实际抓取那个 URL（内容出网），但它自己没标 remote。
 * 那是它自身的分类问题，且改动面不小——`chains/registry.ts` 正是用 `t.remote`
 * 当动作链的出网确认闸（默认拒绝），给它补上会连带改链的行为。
 * 这里先把它按出网对待，保证风险标记不漏（AiBadge 那边的原则：一个都不能漏）。
 */
const NETWORK_ANYWAY = new Set(["url-summary"]);

/**
 * 短文本兜底。
 *
 * `scoreAiAction` 里 ai-summarize 要求 >200 字、ai-rewrite 要求 ≥50 字（“短文本没什么
 * 可摘的”——对变换中心那个满屏候选列表而言是对的）。但快捷栏只有 2-3 个位，
 * “复制了一句话”是最常见的场景，一个动作都不给会让整条 AI 栏直接消失。
 *
 * 历史坑（拿 492 条真实历史回放才发现）：这段兜底曾经是**死代码**，一次都没跑过。
 * 因为 ai-merge-polish / ai-weekly-report 的 content_types 是 `[]`，旧逻辑里
 * “不限类型”=0.45，于是它俩给每一条内容都垫了底分，“一个 AI 候选都没有”永远不成立。
 * 把那两个归入意图型之后它才真正启用。
 */
const FALLBACK: readonly QuickAction[] = [
  { id: "ai-summarize", label: "总结", ai: true },
  { id: "ai-rewrite", label: "改写语气", ai: true },
];

/**
 * 兜底的最小长度。
 *
 * 兜底要解决的是“快捷栏空着”，但给 3 个字的标签补一个“总结”，
 * 和它要解决的问题一样糟——那只是把空白换成了噪声。
 * 真的短到没东西可处理时，整条不渲染才是诚实的。
 */
const FALLBACK_MIN_CHARS = 20;

export interface MatchQuickOptions {
  /** 实际会被送进动作的输入文本（文件/图片条目是从路径派生的，不是 item.text） */
  text: string;
  /** AI 是否可用（总开关 + 密钥）。不可用时一个 AI 动作也不给。 */
  aiOk: boolean;
  /** 已按匹配度降序的候选（来自 applicableTransforms） */
  candidates: QuickCandidate[];
  /**
   * 输入是从文件/图片**路径**派生的。
   *
   * 此时只允许本地动作：路径里带用户名、目录结构、项目名，不能因为
   * “反正有个输入”就隐式发给模型。用户想让 AI 看，得自己去变换中心选。
   */
  pathDerived?: boolean;
  /** 上限（默认 3） */
  max?: number;
}

/**
 * 按候选排名给出快捷动作（去重、最多 max 个）。
 *
 * 注意本函数**不再接 contentType**：类型已经在打分阶段（detect）起作用了，
 * 再接一次就是把删掉的那套并行判断请回来。
 */
export function matchQuickActions(opts: MatchQuickOptions): QuickAction[] {
  const { text, aiOk, candidates, pathDerived = false, max = 3 } = opts;
  if (!text.trim()) return [];

  const out: QuickAction[] = [];
  const seen = new Set<string>();
  const push = (a: QuickAction) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };

  for (const c of candidates) {
    if (c.group !== "ai" && !NON_AI_ALLOW.has(c.id)) continue;
    const ai = c.group === "ai" || !!c.remote || NETWORK_ANYWAY.has(c.id);
    if (pathDerived && ai) continue;
    push({ id: c.id, label: c.label, ai });
  }

  // 兜底三道门：
  // ① 路径派生的输入不兜底——兜底项全是 AI 动作，而这种输入本就不该出网；
  // ② 太短不兜底（见 FALLBACK_MIN_CHARS）；
  // ③ 标识符/路径/单号不兜底。这道门是实测逐出来的：打分已经把
  //   `INCCForHHOrSSService` / `C0805041350000005382` 排除了，而兜底是硬编码 push，
  //   于是又把它们以“总结 / 改写语气”的形式塞了回来。
  //   兜底可以放宽**长度**阀值（快捷栏只有 3 个位，这是它存在的理由），
  //   但不能放宽**形态**判据——那不是尺度问题，是“根本不适用”。
  if (
    !pathDerived &&
    !out.some((a) => a.ai) &&
    text.trim().length >= FALLBACK_MIN_CHARS &&
    !looksLikeIdentifier(text)
  ) {
    FALLBACK.forEach(push);
  }

  // AI 不可用 → 一个 AI 动作也不给（否则就是摆一排点下去只会报错的按钮，
  // 而变换面板那边 scoreAiAction 首行就 return 0、一个都不推，两处必须一致）。
  // 过滤后只剩本地动作或为空；为空时调用方据此整条不渲染。
  return out.filter((a) => aiOk || !a.ai).slice(0, max);
}
