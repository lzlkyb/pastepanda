/**
 * 表格拆分入栈（方案 A+B）：复制的表格文本按行拆分成多条独立文本。
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

/**
 * 竖着复制的一列值（比如 Excel 里选中一列工单号）没有 Tab，parseTable 识别不了。
 * 这里单独处理，不改 parseTable 本身——后者还被「表格→INSERT」那个变换复用，
 * 若让它也认单列，任意多行文本都会被当成表格去生成 SQL，影响面太大。
 * 无表头概念（不像多列那样默认首行是列名），所以每行都算数据，不会丢首行。
 */
function parseSingleColumn(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  if (lines.some((l) => l.includes("\t"))) return null; // 有 Tab 交给上面的多列逻辑处理
  if (lines.some((l) => l.length > MAX_SINGLE_COLUMN_LINE_LENGTH)) return null;
  return lines;
}

export function splitTableToRows(text: string, opts?: SplitTableOptions): SplitTableResult | null {
  const table = parseTable(text);
  if (table) {
    const format = opts?.format ?? "raw";
    const includeHeader = opts?.includeHeader ?? false;

    const formatDataRow = (cells: string[]): string =>
      format === "field-value"
        ? table.columns.map((col, i) => `${col}: ${cells[i] ?? ""}`).join("; ")
        : cells.join("\t");

    const dataRows = table.rows.map(formatDataRow);
    const rows = includeHeader ? [table.columns.join("\t"), ...dataRows] : dataRows;

    return { rows: rows.slice(0, MAX_TABLE_SPLIT_ROWS), totalRows: table.rows.length };
  }

  // 多列识别不了时再试单列：竖着复制的一列值没有列名概念，format/includeHeader 选项对它无意义，直接忽略
  const singleColumn = parseSingleColumn(text);
  if (singleColumn) {
    return { rows: singleColumn.slice(0, MAX_TABLE_SPLIT_ROWS), totalRows: singleColumn.length };
  }

  return null;
}
