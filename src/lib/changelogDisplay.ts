/**
 * changelogDisplay.ts — 更新日志条目的显示口径（桌面弹框与手机半屏共用）
 *
 * 抽这里的唯一原因：`**` 剥离 + 「**标题**：明细 只显标题」这条显示规则此前散在
 * 桌面 UpdateNotesParts 里。手机端要展示同一份 CHANGELOG（parseChangelogSection 的
 * 结构化输出），若各写一份剥离逻辑，两端迟早分叉（新加第 3 个展示端 = 规则 11.1 的坑）。
 * 纯函数、零依赖，桌面/手机都从这里取，配 changelogDisplay.test.ts 守卫钉死口径。
 */

/** 剥离 markdown 加粗符号（**…**）：React 渲染纯文本不解析 markdown，
 *  CHANGELOG 条目的 ** 会原样显示成星号，这里统一剥掉。 */
export function stripBold(s: string): string {
  return s.replace(/\*\*/g, "");
}

/** 条目文本的三种显示形态（与桌面 UpdateNotesParts.renderItemText 严格一致）。 */
export type DisplayItemText =
  /** `**标题**：明细` —— 扫读视图只显标题，明细交给完整手册 / Releases 承接 */
  | { kind: "titleOnly"; title: string }
  /** `标题：明细` 或 `标题 — 明细` —— 拆出加粗引导词 + 其余正文 */
  | { kind: "lead"; lead: string; sep: string; rest: string }
  /** 无结构的普通文本 */
  | { kind: "plain"; text: string };

/**
 * 把一条 CHANGELOG 条目文本拆成显示形态。判据与桌面同源：
 *  - 必须 `**粗体**` 紧跟冒号才走 titleOnly（历史条目多为此格式）；
 *  - 否则命中 `：` / ` — ` 就拆 lead+rest；
 *  - 都不命中则原样（仍剥 `**`）。
 */
export function splitChangelogText(text: string): DisplayItemText {
  const bold = /^\*\*(.+?)\*\*[：:]/.exec(text);
  if (bold) return { kind: "titleOnly", title: stripBold(bold[1]) };
  const m = /^(.+?)(：| — )([\s\S]+)$/.exec(text);
  if (!m) return { kind: "plain", text: stripBold(text) };
  return { kind: "lead", lead: stripBold(m[1]), sep: m[2], rest: stripBold(m[3]) };
}
