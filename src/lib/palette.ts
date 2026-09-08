/**
 * 身份色盘 —— 全应用**唯一**的定色来源。
 *
 * 规范全文见 `docs/PastePanda-色彩规范.md`；真值对照稿见
 * `design/色彩规范-设计稿.html`。这里只重复一件事：怎么选层。
 *
 * ── 问一句：**换个主题后，这个颜色应该跟着变吗？**
 *
 *   - 应该变 → 用主题 token（`--accent` / `--danger` / `--green` / `--orange`）。
 *     它们在 `theme.css` 里按 6 个主题分别调过，带对比度标注。
 *   - 不该变 → 用本表。它表达的是**身份**（这是哪一类 / 哪一个），不含好坏。
 *   - 不该变，且是别人家的 logo 色 → 品牌色，**不属于本表**（见下）。
 *
 * 🔴 本表不是新发明的。实测（2026-09-08）全仓库散在五处的 41 个色值里，
 * 有 21 个已经精确落在 Tailwind 500/600 档上——事实标准本来就存在，
 * 只是五份清单靠人工同步。本表只做**收口**，一个色值都没改。
 */

/**
 * Tailwind 色阶的 500 档为主（个别 400/600/700，已在注释里标明）。
 *
 * ❗ **添新色前先想清楚你要的是不是已有的某个。**
 * 这张表的价值在于小；每多一个邻近色，「这两个东西颜色不一样」就少一分信息量。
 */
export const HUE = {
  red: "#EF4444",      // red-500
  redDeep: "#DC2626",  // red-600：比 red 重一档，给「密钥」这类需要更重的身份用
  orange: "#F97316",   // orange-500
  amber: "#F59E0B",    // amber-500
  lime: "#84CC16",     // lime-500
  green: "#22C55E",    // green-500
  emerald: "#10B981",  // emerald-500
  teal: "#14B8A6",     // teal-500
  cyan: "#06B6D4",     // cyan-500
  sky: "#0EA5E9",      // sky-500
  blue: "#3B82F6",     // blue-500
  indigo: "#6366F1",   // indigo-500
  violet: "#8B5CF6",   // violet-500
  purple: "#A855F7",   // purple-500
  pink: "#EC4899",     // pink-500
  stone: "#78716C",    // stone-500：带暖意的灰，与下面的中性灰不同用
  gray: "#6B7280",     // gray-500
} as const;

export type HueName = keyof typeof HUE;

/**
 * 🔴 **灰只有一个含义：无特征**（日志、纯文本这类本身就没区分度的东西），
 * 而且必须是有人**显式选**的 `HUE.gray` / `HUE.stone`。
 *
 * 它绝不能拿来当「默认值」或「还没配色」。这不是洁癖：
 * `note_vault.rs` 里一行 `IMPORT_TAG_COLOR = "#6B7280"` 已经造成过后果——
 * 真实库里**笔记在用的 10 个标签 10 个全是灰**，而代码无法分辨
 * 那到底是「有人选了灰」还是「根本没选」。
 *
 * 「还没配色」的正确表示是**空串**（见规范 §3 第 3 层）。
 */
export const UNSET_COLOR = "";

/**
 * 没有类型信息时的哈希回退盘。
 *
 * 从 `HUE` 里挑的一个子集，故意**不含任何灰**：
 * 回退的目的就是让它有色，掺进一个灰等于白干。
 * 也不含邻近色（如 green 与 emerald 只取一）：轮转盘里两个色太像时，
 * 用户会以为那两条有关系。
 *
 * ❗ 顺序就是原来 `Card.tsx` 里 `PALETTE` 的顺序，**不能动**：
 * `hashColor` 按下标取色，改顺序 = 全库每一条的颜色都变。
 */
export const FALLBACK_HUES = [
  HUE.blue, HUE.violet, HUE.pink, HUE.emerald,
  HUE.amber, HUE.red, HUE.cyan, HUE.indigo,
] as const;

/**
 * 品牌色**不在本文件**。
 *
 * 它们目前散在两处：`src/lib/source-mappings.ts`（前端）与
 * `src-tauri/src/data_store/tag.rs` 的种子表（后端）。
 * 规范 §5.5 要把它们拆成独立的 `BRAND` 表。
 *
 * 🔴 **在那之前不要在这里建一张空的 `BRAND`**——没人用的表会静默漂移，
 * 而那恰好是本规范要消的问题（五份清单靠人工同步）。
 *
 * 品牌色的铁律：**不参与主题、不参与哈希、不可替换。**
 * 把 Python 蓝扔进 `FALLBACK_HUES` 的轮转里，它就不再是「Python」了。
 */
