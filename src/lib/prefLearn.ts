/**
 * lib/prefLearn.ts —— 偏好自荐（A：反馈 → 偏好）的本地特征提取。
 *
 * ## 为什么需要这一层
 *
 * `ai_feedback` 表按红线**一个字内容都不存**，所以后端只知道"你把 ai-translate 改了 8/12 次"，
 * 完全不知道你改成了什么。没有"怎么改的"，就没法生成偏好句——
 * 系统只能提醒你去手动配，那不叫学到东西。
 *
 * 这个模块在**前端本地**比对（原文, 改后），只产出一组**枚举特征标签**（如 `shorter`），
 * 原文与改动一个字都不出这个函数。落库的只有标签。
 *
 * 红线守法：
 * - 特征是**写死的枚举**，不是从内容里抽出来的字符串——后端还会再校验一次白名单，
 *   所以"只落标签"不依赖前端自觉（见 `data_store/pref_signals.rs`）；
 * - 阈值内不作为：攒够 {@link PREF_SIGNAL_MIN_COUNT} 次同方向才提议，一次改动不打扰。
 *
 * ## 特征 → 偏好句
 *
 * 映射表写死在代码里（{@link PREF_SENTENCE}）。理由同 `SECRET_PREFIXES`：
 * 这是我们对"用户这么改意味着什么"的判断，属于产品逻辑而非用户偏好，随版本更新，不做成可配项。
 */

/** 一个特征标签。**必须与 Rust 侧 `PREF_FEATURES` 白名单逐字一致。** */
export type PrefFeature =
  | "shorter"
  | "longer"
  | "dropped_preamble"
  | "dropped_greeting"
  | "dropped_closing"
  | "dropped_markdown"
  | "formal_to_casual"
  | "casual_to_formal";

/**
 * 同一 (动作, 特征) 攒够几次才提议。
 *
 * 3 是"看得出是习惯而不是一次手滑"的最低档。定 2 会把偶然改动当习惯，
 * 定 5 则要等太久——AI 动作本身用得不密，5 次可能是两周以后的事，那时提议已经失去上下文。
 */
export const PREF_SIGNAL_MIN_COUNT = 3;

/** 特征 → 建议写入 `action_prefs` 的偏好句（会拼进 system prompt，所以要写成对模型的指令）。 */
export const PREF_SENTENCE: Record<PrefFeature, string> = {
  shorter: "输出再精简一些",
  longer: "输出可以更详细一些",
  dropped_preamble: "直接给结果，不要“以下是…”这类开场说明",
  dropped_greeting: "不要加称呼和问候语",
  dropped_closing: "不要加结尾客套话",
  dropped_markdown: "用纯文本，不要 Markdown 标记",
  formal_to_casual: "语气口语一些，不要过度敬语",
  casual_to_formal: "用更正式的措辞",
};

/** 特征 → 给用户看的"我注意到什么"（建议条文案用，第二人称）。 */
export const PREF_OBSERVATION: Record<PrefFeature, string> = {
  shorter: "你常把这个动作的输出改短",
  longer: "你常把这个动作的输出补长",
  dropped_preamble: "你常删掉开头的“以下是…”",
  dropped_greeting: "你常删掉称呼和问候",
  dropped_closing: "你常删掉结尾的客套话",
  dropped_markdown: "你常把 Markdown 标记去掉",
  formal_to_casual: "你常把敬语改得口语一些",
  casual_to_formal: "你常把措辞改得更正式",
};

/** 长度显著变短/变长的阈值。留出 30% 余量，避免把"顺手改个错别字"当成精简意图。 */
const SHORTER_RATIO = 0.7;
const LONGER_RATIO = 1.4;

/** 太短的产物不做长度判断：十几个字的东西删两个字就到 70%，纯噪声。 */
const MIN_LEN_FOR_RATIO = 40;

/** 开场说明（模型爱加的"好的，以下是…"）。只看开头，不整篇搜。 */
const PREAMBLE_RE =
  /^\s*(好的|当然|没问题|以下是|这是|下面是|如下|Sure|Certainly|Here(?:'s| is)|Of course)/i;

/** 称呼与问候。取前两行判断——称呼只会出现在开头。 */
const GREETING_RE = /(你好|您好|亲爱的|尊敬的|敬爱的|Dear\s|Hi[,\s]|Hello[,\s])/i;

/** 结尾客套。取末两行判断。 */
const CLOSING_RE =
  /(祝好|祝顺利|此致|敬礼|顺祝|谢谢您|感谢您的|期待您的回复|Best regards|Sincerely|Regards[,\s]*$|Thanks[,!\s]*$)/i;

/** Markdown 结构标记（**粗体** / ## 标题 / - 列表 / 1. 有序 / `代码`）。 */
const MD_RE = /(\*\*[^*\n]+\*\*|^#{1,6}\s|^[-*+]\s|^\d+\.\s|`[^`\n]+`)/m;

/** 取前 n 行 */
function headLines(s: string, n: number): string {
  return s.split(/\r?\n/, n).join("\n");
}

/** 取末 n 行 */
function tailLines(s: string, n: number): string {
  const lines = s.replace(/\s+$/, "").split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** 数 Markdown 标记出现次数（多行匹配，用于判断"基本去掉了"而非"少了一个"）。 */
function countMd(s: string): number {
  let n = 0;
  for (const line of s.split(/\r?\n/)) {
    if (MD_RE.test(line)) n++;
  }
  return n;
}

/** 敬语密度（"您" 的出现次数）。 */
function countHonorific(s: string): number {
  return (s.match(/您/g) ?? []).length;
}

/**
 * 从一次编辑里提取特征标签。
 *
 * @param before 模型原始产物
 * @param after  用户改完的样子
 * @returns 特征列表（可能为空 = 这次改动看不出方向，不记）
 *
 * **具体特征优先于长度特征**：删掉开场/称呼/客套几乎必然让文本变短，
 * 如果两类都记，`shorter` 会在所有动作上遥遥领先，最后提议出来的永远是
 * 最没用的那句"输出再精简一些"——而用户真正想要的是"别写开场白"。
 * 所以只有在没有任何具体特征命中时，才记长度方向。
 */
export function extractPrefFeatures(before: string, after: string): PrefFeature[] {
  const b = before.trim();
  const a = after.trim();
  // 没改 或 改成空 都没有信号可言
  if (!b || !a || b === a) return [];

  const specific: PrefFeature[] = [];

  // ① 开场说明：原文有、改后没有
  if (PREAMBLE_RE.test(b) && !PREAMBLE_RE.test(a)) {
    specific.push("dropped_preamble");
  }

  // ② 称呼问候：只看前两行
  const bHead = headLines(b, 2);
  if (GREETING_RE.test(bHead) && !GREETING_RE.test(headLines(a, 2))) {
    specific.push("dropped_greeting");
  }

  // ③ 结尾客套：只看末两行
  const bTail = tailLines(b, 2);
  if (CLOSING_RE.test(bTail) && !CLOSING_RE.test(tailLines(a, 2))) {
    specific.push("dropped_closing");
  }

  // ④ Markdown：原文有若干标记，改后掉了一半以上（不是"少一个"）
  const mdBefore = countMd(b);
  if (mdBefore >= 2 && countMd(a) <= mdBefore / 2) {
    specific.push("dropped_markdown");
  }

  // ⑤ 敬语方向："您" 的密度变化。要求原文至少出现 2 次，避免单次误判
  const hBefore = countHonorific(b);
  const hAfter = countHonorific(a);
  if (hBefore >= 2 && hAfter === 0) {
    specific.push("formal_to_casual");
  } else if (hBefore === 0 && hAfter >= 2) {
    specific.push("casual_to_formal");
  }

  if (specific.length > 0) return specific;

  // ⑥ 都没命中才看长度——见上面 doc 里的"具体特征优先"
  if (b.length >= MIN_LEN_FOR_RATIO) {
    const ratio = a.length / b.length;
    if (ratio <= SHORTER_RATIO) return ["shorter"];
    if (ratio >= LONGER_RATIO) return ["longer"];
  }

  return [];
}
