/**
 * kbConflict.ts —— 冲突副本的解析（W4a）。
 *
 * 冲突副本不是一张表、不是一个文件，而是 `sync::engine::save_conflict_copy`
 * 建的**一篇普通笔记**，正文形状：
 *
 * ```text
 * - [conflict] 这是一份**冲突副本**，来自**对端**那一份（时间戳 1757…）。
 *
 * 两台机器在上次同步之后都改过《…》…
 *
 * 原笔记 id：`<uuid>`
 *
 * ---
 *
 * <输的那一份完整 markdown（自带 frontmatter）>
 * ```
 *
 * # 🔴 为何不建一张关联表
 *
 * 副本本身**会同步到对端**（它就是一篇普通笔记，`note_changed_since`
 * 只筛 `deleted_at IS NULL AND updated_ms > ?`，同步链路上没有任何地方排除它）；
 * 而一张本机表是本地记账、**不会同步** —— 对端收到副本后查表查不到原笔记，
 * 「在任一台处理一次，两边都干净」这个性质就没了。
 * 关联必须待在**跟着正文一起走**的地方，所以就解正文。
 *
 * # 🔴 为何必须剥掉 frontmatter 再比
 *
 * 副本里嵌的是 `note_to_markdown` 的产物，带 frontmatter，而其中
 * `created` / `updated` 是**本机时间字串** —— 同一篇笔记在两台机器上必然不同。
 * 不剥就直接 diff，头几行永远是红的，而真正的内容差异泡在噪声里。
 * `engine.rs` 的 `same_version` 踩过同一个坑（那里的注释明写
 * 「不能直接比整份文件的字节」，第一版就是这么错的）。
 */

/**
 * 正文里那行行内类别标记。
 *
 * ❗ 与后端 `note_conflict_count()` 用的是同一个字样
 * （那边是 `content LIKE '%- [conflict]%'`）。两处口径必须一致，
 * 否则会出现「状态条说有 3 处、而打开哪一篇都不给入口」。
 */
export const CONFLICT_MARK = "- [conflict]";

export interface ConflictCopy {
  /** 原笔记 id。 */
  originId: string;
  /** 输的那一份来自哪边：`本机` / `对端`。取不到时为空串。 */
  losingSide: string;
  /** 输的那一份的 HLC 时间戳（毫秒）。取不到为 0。 */
  losingMs: number;
  /** 输的那一份的**正文**（已剥掉 frontmatter）。 */
  losingContent: string;
}

/** 这篇是不是冲突副本。只看标记，**不看标题** —— 标题用户会改。 */
export function isConflictCopy(content: string): boolean {
  return content.includes(CONFLICT_MARK);
}

/**
 * 剥掉 markdown 的 frontmatter，只留正文。
 *
 * 格式按 `note_md.rs` 的 `to_markdown`：`---\n` + 若干 `key: value` 行 + `---\n\n` + 正文。
 *
 * ❗ 降级口径与后端 `markdown_to_note` 一致：**解不出就整文当正文**，
 * 不报错。一份 frontmatter 坏了的副本不应该让对照视图直接不能用。
 */
export function stripFrontmatter(md: string): string {
  // 🔴 先去掉开头的空行，**再**判 `---` 前缀。
  //    副本里那个分隔符后面跟着一个空行，所以传进来的串是
  //    `"\n---\ntitle: …"` 而不是 `"---\ntitle: …"`。先判后去的话前缀对不上，
  //    整份 frontmatter 原样返回 —— 而那正是本模块要除掉的噪声。
  const text = md
    .replace(/\r\n/g, "\n")
    .replace(/^\uFEFF/, "")
    .replace(/^\n+/, "");
  if (!text.startsWith("---\n")) return text;
  const lines = text.split("\n");
  // 从第二行起找闭合的 `---`
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
    }
  }
  return text; // 没有闭合符 → 整文当正文
}

/**
 * 解一篇冲突副本。解不出关键信息时返 `null`（调用方得**如实降级**，
 * 只给「手动拼」，不假装能对照 —— 规则 #15.3）。
 *
 * # 为何用全文宽松正则而不按行号定位
 *
 * 用户会在副本里插东西（它就是一篇可编辑的笔记）。按行号抽一插就死；
 * 而整文找那两个标记，插多少段都不影响。
 */
export function parseConflictCopy(content: string): ConflictCopy | null {
  const text = content.replace(/\r\n/g, "\n");
  // 全宽冒号来自 `save_conflict_copy` 里那个中文冒号；反引号包的可能不是 uuid
  // （`note_create_keeping_id` 允许 vault 导入带任意 id 进来），所以不钉 uuid 形状。
  const idM = text.match(/原笔记 id：`([^`\n]+)`/);
  if (!idM) return null;

  // 分隔符：id 那行**之后**第一条单独成行的 `---`。
  // 不能从头找：说明里万一有 `---` 就切错了。
  const afterId = text.slice(idM.index! + idM[0].length);
  const lines = afterId.split("\n");
  const sep = lines.findIndex((l) => l.trim() === "---");
  if (sep < 0) return null;

  const sideM = text.match(/来自\*\*(.+?)\*\*那一份/);
  const msM = text.match(/时间戳\s*(\d+)/);

  return {
    originId: idM[1],
    losingSide: sideM ? sideM[1] : "",
    losingMs: msM ? Number(msM[1]) : 0,
    // ❗ 去掉末尾换行：`save_conflict_copy` 的格式串在 markdown 后面固定加了一个 `\n`。
    //   不去的后果有两层：对照时多一行空行的假差异；以及「用副本那一份」
    //   写回原笔记时每采用一次就多一个尾空行。
    losingContent: stripFrontmatter(lines.slice(sep + 1).join("\n")).replace(/\n+$/, ""),
  };
}
