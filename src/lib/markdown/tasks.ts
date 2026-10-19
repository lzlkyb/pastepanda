/**
 * Markdown 任务列表（GFM `- [ ]` / `- [x]`）的源码定位 —— 预览态直接勾选的回写底座。
 *
 * 为什么不用正则扫全文：代码块、行内代码里也会出现 `- [ ]`，逐行正则会把它们
 * 当成任务项，从第一个误判之后**所有索引整体错位**，表现为「勾第 7 项改到了第 8 项」。
 * 所以这里走 marked 自己的 lexer：`list_item.task === true` 才认，代码块天然排除。
 *
 * 定位方式：递归遍历 token 树，用 `item.raw` 在同一容器范围内 `indexOf` 找绝对偏移。
 * 实测（marked 18）`list_item.raw` 含前导列表符号（`- [ ] A. …` / `1. [ ] …`），
 * 嵌套项在父项 raw 范围内搜索，因此任意层级都能拿到准确位置。
 *
 * 一致性保证：渲染侧（MarkdownRenderer 的 checkbox renderer）与写回侧
 * （toggleTaskAt）用的是**同一份** `scanTaskItemsFromTokens` —— 索引天然对齐。
 * 一旦扫描发现无法定位（`complete === false`），两侧一起退回只读，绝不猜位置。
 */
import { marked, type Token } from "marked";

export interface TaskItem {
  /** 文档内第几个任务项（0 起，与预览渲染顺序一致） */
  index: number;
  /** 源码行号（1 起，仅用于调试与提示） */
  line: number;
  /** `[` 与 `]` 之间那个字符的绝对偏移 —— 写回就改这一个字符 */
  charPos: number;
  checked: boolean;
}

export interface TaskScan {
  items: TaskItem[];
  /** false = 有 token 定位失败（结构异常）⇒ 整个预览不开放勾选 */
  complete: boolean;
}

/** token 的宽松视图：只取本模块用到的字段，避免对 marked 内部联合类型做窄化 */
type LooseToken = Token & {
  raw?: string;
  items?: LooseToken[];
  tokens?: LooseToken[];
  task?: boolean;
  checked?: boolean;
};

const MARKER_RE = /(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;

/** 行号：任务文档都在几百行内，逐字符数换行足够，不必建索引 */
function lineOf(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * 在 `[start, end)` 内找条目自己的复选框标记，返回 `[ ]` 中间那个字符的绝对偏移。
 * 条目 raw 以列表符号开头，所以取第一个匹配即为本条目的标记。
 */
function markerPos(src: string, start: number, end: number): number {
  const m = MARKER_RE.exec(src.slice(start, end));
  if (!m) return -1;
  // m[0] 以 `]` 结尾 ⇒ 括号内字符在倒数第二位
  return start + m.index + m[0].length - 2;
}

interface WalkState {
  ok: boolean;
  /** 遍历中遇到的 checkbox token 数（用于校验「渲染数 == 定位数」） */
  boxes: number;
}

function childrenOf(token: LooseToken, src: string, start: number, end: number, out: TaskItem[], st: WalkState): void {
  if (token.items?.length) walkTokens(token.items, src, start, end, out, st);
  else if (token.tokens?.length) walkTokens(token.tokens, src, start, end, out, st);
}

function walkTokens(
  tokens: readonly LooseToken[],
  src: string,
  rangeStart: number,
  rangeEnd: number,
  out: TaskItem[],
  st: WalkState,
): void {
  let cursor = rangeStart;
  for (const token of tokens) {
    if (token.type === "checkbox") st.boxes += 1;

    const raw = typeof token.raw === "string" ? token.raw : "";
    if (!raw) {
      childrenOf(token, src, cursor, rangeEnd, out, st);
      continue;
    }

    const start = src.indexOf(raw, cursor);
    // 定位不到就整棵子树跳过（继续猜位置会改错行）；complete 会因此变 false
    if (start < 0 || start >= rangeEnd) {
      st.ok = false;
      continue;
    }
    const end = Math.min(start + raw.length, rangeEnd);

    if (token.type === "list_item" && token.task === true) {
      const pos = markerPos(src, start, end);
      if (pos < 0 || pos >= src.length) {
        st.ok = false;
      } else {
        out.push({ index: out.length, line: lineOf(src, pos), charPos: pos, checked: token.checked === true });
      }
    }

    childrenOf(token, src, start, end, out, st);
    cursor = end;
  }
}

/** 用已解析的 token 树做扫描（渲染侧复用同一份 token，避免重复 lex） */
export function scanTaskItemsFromTokens(tokens: readonly Token[], src: string): TaskScan {
  const items: TaskItem[] = [];
  const st: WalkState = { ok: true, boxes: 0 };
  walkTokens(tokens as readonly LooseToken[], src, 0, src.length, items, st);
  // 渲染器按顺序给每个 checkbox 编号；数量不一致说明有 token 没定位到 ⇒ 全部只读
  return { items, complete: st.ok && st.boxes === items.length };
}

/** 扫描源码里的任务项（写回前、渲染前各调一次；同一份文本结果稳定） */
export function scanTaskItems(md: string): TaskScan {
  return scanTaskItemsFromTokens(marked.lexer(md), md);
}

/** 只统计进度（不定位，因此不会因结构异常而丢项） */
export function countTaskProgress(md: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const visit = (tokens: readonly LooseToken[]): void => {
    for (const t of tokens) {
      if (t.type === "list_item" && t.task === true) {
        total += 1;
        if (t.checked === true) done += 1;
      }
      if (t.items?.length) visit(t.items);
      else if (t.tokens?.length) visit(t.tokens);
    }
  };
  visit(marked.lexer(md) as readonly LooseToken[]);
  return { done, total };
}

/**
 * 翻转第 index 个任务项。返回 null 表示**不写**（定位不可信 / 下标越界 / 那个位置
 * 不是空格或 x），调用方据此回滚乐观勾选，避免「看着勾上了、文件没变」的假绿。
 *
 * 勾选统一写小写 `x`：`[X]` 取消后再勾会变成 `[x]`，与主流编辑器一致。
 */
export function toggleTaskAt(md: string, index: number): { next: string; charPos: number; insert: string } | null {
  const scan = scanTaskItems(md);
  if (!scan.complete) return null;
  const item = scan.items[index];
  if (!item) return null;
  const ch = md[item.charPos];
  if (ch !== " " && ch !== "x" && ch !== "X") return null;
  const insert = ch === " " ? "x" : " ";
  return { next: md.slice(0, item.charPos) + insert + md.slice(item.charPos + 1), charPos: item.charPos, insert };
}
