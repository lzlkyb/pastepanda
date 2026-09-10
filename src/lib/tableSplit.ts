/**
 * 表格拆分入栈（方案 A+B）：复制的表格文本按行拆分成多条独立文本。
 *
 * # 🔴 预处理一律写在这里，不改 `parseTable`
 *
 * `parseTable` 还被「表格→INSERT」那个变换复用。放宽它的判据，任意多行文本
 * 都会被当成表格去生成 SQL，影响面太大。所以这里的做法是：把「明显是表格、
 * 但 `parseTable` 认不出来」的形状**规整成它能认的样子**再递过去。
 *
 * # 实测出来的几个坑（2026-09-10，都带回归测试）
 *
 * - 单列带尾部 Tab（Excel 选区带了相邻空列就这么给）→ 首行被当表头吃掉，
 *   复制 3 个工单号只入栈 2 条，而提示还说「已按行拆 2 条」；
 * - 边框表格里某个值含 `|` → 边框解析失败 → 掉进单列兜底 →
 *   `+----+------+` 这种分隔线也被逐行入栈，产出一堆垃圾；
 * - 首行是合并标题行的 Excel 表 → 首行不含 Tab 就全否；
 * - Tab 表格里混进任何一行像 `+---+` 的 → `parseTable` 锁定边框分支且不回退；
 * - 单列里只要有一行超 80 字或含一个 Tab → **整批**否决。
 */
import { parseTable } from "./transforms/queryResultToSql";

export type TableSplitFormat = "raw" | "field-value";

export interface SplitTableOptions {
  format?: TableSplitFormat;
  includeHeader?: boolean;
}

export interface SplitTableResult {
  rows: string[];
  totalRows: number;
}

/** 单次拆分最多保留的行数，与粘贴栈本身的 50 条上限对齐 */
export const MAX_TABLE_SPLIT_ROWS = 50;

/** 单列候选里单行超过这个长度就不再当列表处理——更像段落文本而非一行一个短值 */
const MAX_SINGLE_COLUMN_LINE_LENGTH = 80;

/** 单列判定：至少这个比例的行得像「一行一个短值」 */
const SINGLE_COLUMN_MIN_RATIO = 0.6;

/** 允许剔掉的前导标题行上限。再多就不是「表格前面有个标题」而是段落了 */
const MAX_TITLE_PREFIX_LINES = 3;

/** 拆行并去掉空行。各预处理口径一致，避免一处 filter 一处不 filter */
function contentLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/** 文本里有 `+---+` 分隔线 = 边框表格 */
const BORDER_LINE_RE = /^\+[-+]+\+$/;
function hasBorderLine(text: string): boolean {
  return contentLines(text).some((l) => BORDER_LINE_RE.test(l.trim()));
}

/**
 * 去掉每行尾部的空单元格。**只在去完之后一个 Tab 都不剩时**返回结果，
 * 否则返 `null` 把原文原样交给后面的多列逻辑。
 *
 * 🔴 为何必须这么窄：Excel 选区带了相邻空列时，复制出来每行末尾挂一个 Tab
 * （`"D-001\t"`）。那一个 Tab 足以让它走多列分支，于是首行 `D-001` 被当成表头
 * 吃掉——用户复制 3 个工单号只入栈 2 条。
 *
 * ❗ 不能无条件剔尾部空单元格：`"a\tb\tc"` + `"1\t\t"` 这种真多列表，
 *   逐行剔完会把列数弄成不一致，反而把原本能拆的变成拆不了。
 */
function stripTrailingEmptyCells(text: string): string | null {
  const lines = contentLines(text);
  if (!lines.some((l) => l.includes("\t"))) return null; // 本来就没 Tab，交给单列逻辑
  const stripped = lines.map((l) => {
    const cells = l.split("\t");
    while (cells.length > 1 && cells[cells.length - 1].trim() === "") cells.pop();
    return cells.join("\t");
  });
  if (stripped.some((l) => l.includes("\t"))) return null; // 还剩 Tab = 真多列
  return stripped.join("\n");
}

/**
 * 剔掉前导的非 Tab 行（合并标题行）。
 *
 * ❗ 剔完之后要求**每一行**都含 Tab，且至少剩两行。否则就是把一段散文的
 *   开头切掉、硬凑成表格——那比拆不了更糟。
 */
function dropTitlePrefix(text: string): string | null {
  const lines = contentLines(text);
  let i = 0;
  while (i < lines.length && i < MAX_TITLE_PREFIX_LINES && !lines[i].includes("\t")) i++;
  if (i === 0 || i >= lines.length) return null;
  const rest = lines.slice(i);
  if (rest.length < 2) return null;
  if (!rest.every((l) => l.includes("\t"))) return null;
  return rest.join("\n");
}

/**
 * 剔掉 `+---+` 分隔线，让一张「混进了边框线的 Tab 表格」能走回 Tab 分支。
 *
 * 🔴 `parseTable` 一看见任何一行像边框就**锁定**边框分支且不回退，
 * 于是一张正常的 Tab 表格只要数据里有一行 `+----+` 就彻底拆不了。
 */
function dropBorderLines(text: string): string | null {
  const kept = contentLines(text).filter((l) => !BORDER_LINE_RE.test(l.trim()));
  if (kept.length < 2) return null;
  if (!kept.some((l) => l.includes("\t"))) return null; // 剔完还是没 Tab，白剔
  return kept.join("\n");
}

/**
 * 把单元格不够的数据行补齐到表头列数。
 *
 * `parseTabSeparated` 的容差只允许少 1 个单元格，少两个就整张表否决。
 * 拆分场景下用户已经明确复制了表格，容差该放宽。
 *
 * ❗ 但不能无条件补：一段散文里夹了一行 Tab，补完也能“通过”。
 *   所以要求**至少一半数据行本来就含 Tab**。
 */
function padShortRows(text: string): string | null {
  const lines = contentLines(text);
  if (lines.length < 2) return null;
  if (!lines[0].includes("\t")) return null;
  const cols = lines[0].split("\t").length;
  if (cols < 2) return null;
  const data = lines.slice(1);
  const withTab = data.filter((l) => l.includes("\t")).length;
  if (withTab * 2 < data.length) return null;
  const padded = data.map((l) => {
    const cells = l.split("\t");
    while (cells.length < cols) cells.push("");
    return cells.join("\t");
  });
  return [lines[0], ...padded].join("\n");
}

/**
 * 竖着复制的一列值（比如 Excel 里选中一列工单号）没有 Tab，`parseTable` 识别不了。
 * 这里单独处理。无表头概念（不像多列那样默认首行是列名），所以每行都算数据。
 *
 * 🔴 「像不像列表」是**比例判定**，判定成立就**整批保留**，不扔任何一行。
 * 以前是「任一行超 80 字或含 Tab 就整批否决」，于是复制一列 URL / 一列备注时
 * 整个功能经常失灵。而反过来「把不像的那几行踢掉」也不行——那是静默丢数据，
 * 与上面那条首行被吃掉的 bug 同一类。
 */
function parseSingleColumn(text: string): string[] | null {
  const lines = contentLines(text).map((l) => l.trim());
  if (lines.length < 2) return null;
  const listLike = lines.filter(
    (l) => !l.includes("\t") && l.length <= MAX_SINGLE_COLUMN_LINE_LENGTH,
  ).length;
  if (listLike < 2) return null;
  if (listLike < lines.length * SINGLE_COLUMN_MIN_RATIO) return null;
  return lines;
}

/**
 * 存放被保护的换行的哨兵字符。选 NUL：剪贴板文本里几乎不可能出现，
 * 而一旦真出现了就整段放弃处理（见 [`protectQuotedNewlines`]）。
 */
const NL_SENTINEL = "\u0000";

/**
 * Excel 把「单元格内含换行」的格子用引号包起来，换行原样留在里面：
 *
 * ```text
 * 单号\t备注
 * D-001\t"第一行
 * 第二行"
 * D-002\tok
 * ```
 *
 * 按行切会把一个格子劈成两条、引号还留着（实测拆出 3 条，第一条是
 * `D-001\t"第一行`）——数据被静默破坏。这里把**引号内**的换行换成哨兵
 * 字符再交给 `parseTable`，出结果后由 [`unprotectCell`] 换回来。
 *
 * ❗ 三道阀门，宁可不处理也不能把用户内容改坏：
 *   ① 没引号直接走原路；② 哨兵字符本来就出现过就放弃；
 *   ③ 引号不成对（扫完还在引号里）说明这不是 Excel 那套转义，也放弃。
 */
function protectQuotedNewlines(text: string): string | null {
  if (!text.includes('"')) return null;
  if (text.includes(NL_SENTINEL)) return null;
  let out = "";
  let inQuote = false;
  let hit = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      inQuote = !inQuote;
      out += c;
      continue;
    }
    if (inQuote && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++; // CRLF 折成一个哨兵
      out += NL_SENTINEL;
      hit = true;
      continue;
    }
    out += c;
  }
  if (inQuote) return null;
  if (!hit) return null; // 有引号但里面没换行，没必要动
  return out;
}

/** 还原被保护的换行，并按 TSV 约定去掉包裹引号（`""` 还原成 `"`）。 */
function unprotectCell(cell: string): string {
  let v = cell;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/""/g, '"');
  }
  return v.split(NL_SENTINEL).join("\n");
}

/**
 * 看着像表格，但 [`splitTableToRows`] 没拆成。
 *
 * 🔴 给用户一句解释用的。以前拆不成就静默整条入栈，提示只说「入栈 1 条」，
 * 用户看不出是「它认出是表格但没拆开」还是「它压根没试」（规则 #15.3）。
 */
export function looksLikeTableButUnsplit(text: string): boolean {
  const lines = contentLines(text);
  if (lines.length < 2) return false;
  if (hasBorderLine(text)) return true;
  const withTab = lines.filter((l) => l.includes("\t")).length;
  return withTab * 2 >= lines.length;
}

export function splitTableToRows(text: string, opts?: SplitTableOptions): SplitTableResult | null {
  // ⓪ Excel 的「单元格内含换行」用引号包着，先把引号内的换行藏起来，
  //   否则按行切会把一个格子劈成两条。出结果时再还原。
  const guarded = protectQuotedNewlines(text);
  const work = guarded ?? text;
  const unwrap = guarded === null ? (c: string) => c : unprotectCell;

  const single = (rows: string[]): SplitTableResult => {
    const mapped = rows.map(unwrap);
    return {
      rows: mapped.slice(0, MAX_TABLE_SPLIT_ROWS),
      totalRows: mapped.length,
    };
  };

  // ① 先判「其实是一列」：每行尾部挂的那个 Tab 不能把首行变成表头。
  const asSingle = stripTrailingEmptyCells(work);
  if (asSingle !== null) {
    const col = parseSingleColumn(asSingle);
    if (col) return single(col);
  }

  let table = parseTable(work);

  // ② 边框表格：解析不成时剔掉分隔线再试 Tab 分支；仍不成就到此为止。
  //   🔴 绝不能掉进下面的单列兜底：实测一张某值含 `|` 的边框表会被当成
  //   单列列表，把 `+----+------+` 这种分隔线也逐行入栈，产出 6 条垃圾。
  if (!table && hasBorderLine(work)) {
    const noBorder = dropBorderLines(work);
    table = noBorder ? parseTable(noBorder) : null;
    if (!table) return null;
  }

  // ③ 首行是合并标题行
  if (!table) {
    const trimmed = dropTitlePrefix(work);
    if (trimmed) table = parseTable(trimmed);
  }

  // ④ 数据行单元格不够
  if (!table) {
    const padded = padShortRows(work);
    if (padded) table = parseTable(padded);
  }

  if (table) {
    const t = table;
    const format = opts?.format ?? "raw";
    const includeHeader = opts?.includeHeader ?? false;
    const cols = t.columns.map(unwrap);

    const formatDataRow = (cells: string[]): string =>
      format === "field-value"
        ? cols.map((col, i) => `${col}: ${unwrap(cells[i] ?? "")}`).join("; ")
        : cells.map(unwrap).join("\t");

    const dataRows = t.rows.map(formatDataRow);
    const rows = includeHeader ? [cols.join("\t"), ...dataRows] : dataRows;

    return { rows: rows.slice(0, MAX_TABLE_SPLIT_ROWS), totalRows: t.rows.length };
  }

  // ⑤ 多列全部试完还不行，最后试单列：竖着复制的一列值没有列名概念，
  //   format/includeHeader 选项对它无意义，直接忽略
  const singleColumn = parseSingleColumn(work);
  if (singleColumn) return single(singleColumn);

  return null;
}

/**
 * 哪些条目类型参与表格拆分。
 *
 * # 🔴 必须收口在这一处
 *
 * 两个入口——栈已开时剪贴板到达（`stackPushOrSplit`）与栈未开时按粘贴热键
 * （`stackAutoSplitAndPasteFirst`）——必须用同一判据。以前前者卡 type、后者
 * 根本不检查，于是同一张表格「先开栈再复制」拆不了、「直接按热键」却拆得动。
 *
 * 🔴 `doc` 必须在里面。它正是 **Excel / 网页表格**的类型：
 * `detect_doc_fragment` 把 `<table` 当**强信号**（`clipboard_monitor.rs`），
 * 而 `doc_capture` 默认开。漏掉它等于把最常见的表格来源排除在外——
 * 这就是用户报的「有时候按表格拆分不了」的主因。
 *
 * ❗ 新增条目类型时记得回来看这里（规则 #11.1）。排除 image/file/diagram：
 *   它们的 `text` 是路径或 JSON，按行拆开没有意义。
 */
export const TABLE_SPLIT_TYPES: readonly string[] = ["text", "rich", "doc"];

export function isTableSplitCandidate(type: string): boolean {
  return TABLE_SPLIT_TYPES.includes(type);
}
