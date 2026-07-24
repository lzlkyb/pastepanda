/**
 * csv.ts — 轻量 CSV/TSV 解析与转换（P4 CsvEditor 专用）。
 *
 * 解析规则与 Rust ContentClassifier::is_csv 对齐：
 *   - 至少 2 个非空行；
 *   - 取前 5 个非空行，按分隔符切分后列数全部相等且 ≥2；
 *   - 不支持引号包裹字段（分类器同样不支持，含引号嵌逗号的文本不会被判为 csv）。
 */

export type CsvDelimiter = "," | "\t";

export interface CsvData {
  /** 首行作为表头 */
  headers: string[];
  /** 数据行（不含表头） */
  rows: string[][];
  delimiter: CsvDelimiter;
  /** 列数 */
  columnCount: number;
  /** 总行数（含表头） */
  rowCount: number;
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/**
 * 探测分隔符：先试逗号（与分类器顺序一致），
 * 前 5 个非空行逗号切分列数一致且 ≥2 则判为逗号，否则回退制表符。
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = nonEmptyLines(text).slice(0, 5);
  if (lines.length === 0) return ",";
  const commaCounts = lines.map((l) => l.split(",").length);
  if (commaCounts[0] >= 2 && commaCounts.every((c) => c === commaCounts[0])) return ",";
  return "\t";
}

/**
 * 解析表格文本。结构不一致（列数不等 / 单行 / 单列）时返回 null，
 * 调用方据此回退纯文本编辑。
 */
export function parseCsv(text: string): CsvData | null {
  const lines = nonEmptyLines(text);
  if (lines.length < 2) return null;
  const delimiter = detectDelimiter(text);
  const sample = lines.slice(0, 5);
  const counts = sample.map((l) => l.split(delimiter).length);
  const columnCount = counts[0];
  if (columnCount < 2 || !counts.every((c) => c === columnCount)) return null;
  const cells = lines.map((l) => l.split(delimiter).map((c) => c.trim()));
  return {
    headers: cells[0],
    rows: cells.slice(1),
    delimiter,
    columnCount,
    rowCount: cells.length,
  };
}

/** 转为 Markdown 表格（表头 + 分隔行 + 数据行） */
export function csvToMarkdown(data: CsvData): string {
  const header = "| " + data.headers.join(" | ") + " |";
  const sep = "| " + data.headers.map(() => "---").join(" | ") + " |";
  const rows = data.rows.map((r) => "| " + r.join(" | ") + " |");
  return [header, sep, ...rows].join("\n");
}

/** 转为 JSON 数组（以首行表头为键） */
export function csvToJson(data: CsvData): string {
  const arr = data.rows.map((r) => {
    const obj: Record<string, string> = {};
    data.headers.forEach((h, i) => {
      obj[h] = r[i] ?? "";
    });
    return obj;
  });
  return JSON.stringify(arr, null, 2);
}

/**
 * 分隔符互转：to="," 把制表符换成逗号，to="\t" 反之。
 * 仅处理无引号简单表格（与分类器判定范围一致）。
 */
export function convertDelimiter(text: string, to: CsvDelimiter): string {
  const from: CsvDelimiter = to === "," ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .map((l) => l.split(from).join(to))
    .join("\n");
}
