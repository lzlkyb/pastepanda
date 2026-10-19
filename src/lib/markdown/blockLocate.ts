/**
 * Markdown 顶层块的源码定位 —— 预览态「双击块 → 浮层编辑源码 → 写回」的底座。
 *
 * 与 tasks.ts 同一套架构：渲染侧与写回侧用**同一份** collectTopBlocks，
 * 索引天然对齐；扫描不完整（complete === false）时两侧一起退回只读，绝不猜位置。
 *
 * 顶层块的口径（与渲染器 md-blknum 的注入规则一致）：
 * - 跳过 `space`（空行 token，不产生 DOM 元素）与 `hr`（blknum 也不编号）。
 * - 其余每个顶层 token 恰好对应预览里的一个顶层元素。已知例外：**一个 `html`
 *   token 里写了多个根级标签时**（如 `<div>a</div><div>b</div>` 连写），DOM 会有
 *   多个兄弟元素而 token 只有一个 —— 渲染侧在挂 `data-blk-i` 前会核对两侧数量，
 *   数量对不上就不开放编辑（比错位改块安全）。
 *
 * 定位方式：顶层 token.raw 首尾相接**恰好铺满全文**（实测 marked 18，
 * 空行归 `space` token），所以用一个游标逐个 `indexOf` 即得绝对偏移。
 */
import { marked, type Token } from "marked";

export interface TopBlock {
  /** 文档内第几个顶层块（0 起，跳过 hr/空行后与预览 DOM 顺序一致） */
  index: number;
  /** 源码行号（1 起，调试与提示用） */
  line: number;
  /** 源码中的绝对区间 [from, to) */
  from: number;
  to: number;
  /** 原始源码（写回时的 expectRaw 校验依据） */
  raw: string;
}

/** token 的宽松视图：只取本模块用到的字段 */
type LooseToken = Token & { raw?: string };

/** 行号：文档都在几百行内，逐字符数换行足够 */
function lineOf(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * 收集顶层块。complete=false 表示有 token 定位失败（结构异常），
 * 调用方必须整体退回只读，不能拿半份数据去猜。
 */
export function collectTopBlocks(md: string): { blocks: TopBlock[]; complete: boolean } {
  let tokens: LooseToken[];
  try {
    tokens = marked.lexer(md) as LooseToken[];
  } catch {
    return { blocks: [], complete: false };
  }
  const blocks: TopBlock[] = [];
  let cursor = 0;
  for (const t of tokens) {
    const raw = t.raw ?? "";
    if (t.type === "space") {
      cursor += raw.length; // 空行不产出块，但占源码区间
      continue;
    }
    if (t.type === "hr") {
      // hr 与 blknum 口径一致：不编号。从游标推进时用 indexOf 兜住 raw 不连续的极端情况
      const i = md.indexOf(raw, cursor);
      cursor = i < 0 ? cursor + raw.length : i + raw.length;
      continue;
    }
    const from = md.indexOf(raw, cursor);
    if (from < 0) return { blocks, complete: false };
    const to = from + raw.length;
    cursor = to;
    blocks.push({ index: blocks.length, line: lineOf(md, from), from, to, raw });
  }
  return { blocks, complete: true };
}

export interface BlockReplace {
  /** 替换后的全文 */
  next: string;
  from: number;
  to: number;
  insert: string;
}

/**
 * 把第 index 个顶层块的源码换成 newRaw。
 *
 * expectRaw 是打开浮层时给用户看的那份源码：写回瞬间重新定位并逐字比对，
 * 不一致说明期间文档被改过（编辑区输入 / 勾选翻转），拒绝写入 —— 宁可让用户
 * 重开一次浮层，也不能把内容写进错误的区间。
 *
 * 结尾换行保护：紧贴下一块的段落 raw 自带 `\n`（如 `A\n- x` 里的 `"A\n"`）。
 * 若用户编辑后把结尾换行删了，直接替换会让 `A2- x` 粘成一个段落 ——
 * 所以原 raw 以换行结尾而 newRaw 没有时，自动补回一个。
 */
export function replaceBlockAt(
  md: string,
  index: number,
  newRaw: string,
  expectRaw: string,
): BlockReplace | null {
  const { blocks, complete } = collectTopBlocks(md);
  if (!complete) return null;
  const b = blocks[index];
  if (!b || b.raw !== expectRaw) return null;
  let insert = newRaw;
  if (insert !== "" && /\n$/.test(b.raw) && !/\n$/.test(insert)) insert += "\n";
  return {
    next: md.slice(0, b.from) + insert + md.slice(b.to),
    from: b.from,
    to: b.to,
    insert,
  };
}
