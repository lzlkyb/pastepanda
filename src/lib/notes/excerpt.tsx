/**
 * 笔记列表的摘要与搜索高亮（A1/B3）。
 *
 * 从 `NoteList.tsx` 抽出来的两个理由：
 * ① 那个文件已经超了规则 #7 的 300 行；
 * ② `excerpt` 本来就被 `TrashPanel` 引用，放在一个列表组件里导出不合适。
 *
 * 🔴 红线：纯展示层，无 AI、不联网。
 */
import { Fragment } from "react";

/** 列表行摘要的默认长度。 */
const EXCERPT_LEN = 120;

/** 命中前面多留几个字做上下文。太少读不出语境，太多就把命中挤到右边去了。 */
const LEAD = 24;

/** 抽掉换行与 Markdown 行首标记，只留一行可读的文字。 */
function flatten(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 正文摘要（无关键词时的默认行为）。 */
export function excerpt(content: string): string {
  return flatten(content).slice(0, EXCERPT_LEN);
}

/**
 * 带关键词的摘要：**截到命中处附近**，而不是固定取前 120 字。
 *
 * ❗ 不这么做的后果：命中在第 300 字时，用户搜到了一条却在摘要里什么也看不到，
 *   得点开才知道为什么它被搜出来。
 *
 * 关键词在正文里没有**字面**命中时（拼音首字母、bigram 部分命中都属于这种）
 * 退回普通摘要——不编一个位置出来。
 */
export function excerptAround(content: string, keyword: string): string {
  const flat = flatten(content);
  const kw = keyword.trim();
  if (!kw) return flat.slice(0, EXCERPT_LEN);
  const at = flat.toLowerCase().indexOf(kw.toLowerCase());
  if (at < 0) return flat.slice(0, EXCERPT_LEN);
  const start = Math.max(0, at - LEAD);
  // 前面真的截掉了东西才加省略号；从头开始的话加一个反而像丢了内容。
  const head = start > 0 ? "…" : "";
  return head + flat.slice(start, start + EXCERPT_LEN);
}

/** 正则元字符转义。关键词是用户输的，`.` `*` `(` 这些字符完全可能出现。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把 `text` 里命中 `keyword` 的部分包成 `<mark>`（B3）。
 *
 * 🔴 **为何不用 FTS5 的 `snippet()` / `highlight()`**：`notes_fts` 里存的不是原文，
 *   而是 `to_ngram()` 变形后的文本——中文被拆成「单字 + bigram」并用空格连接
 *   （`history.rs` 里的 `to_ngram`）。FTS5 返回的会是被空格切碎的 ngram 串，
 *   根本不能直接给人看。所以高亮只能在前端对**原文**做。
 *
 * ❗ 因此它只能高亮**字面命中**。拼音首字母搜到的、靠 bigram 部分命中的，
 *   这里匹配不上就**不高亮**——宁可不标，也不能标错地方。
 */
export function highlight(text: string, keyword: string): React.ReactNode {
  const kw = keyword.trim();
  if (!kw) return text;
  const parts = text.split(new RegExp(`(${escapeRe(kw)})`, "gi"));
  // 没命中时 split 只会返回一段，直接返原串少建一堆节点。
  if (parts.length === 1) return text;
  const lower = kw.toLowerCase();
  return parts.map((p, i) =>
    p.toLowerCase() === lower ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>,
  );
}
