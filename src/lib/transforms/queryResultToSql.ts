/**
 * transforms/queryResultToSql.ts — 查询结果表格 → INSERT 语句。
 *
 * 支持两种常见格式：
 * 1. Tab 分隔（从数据库客户端 / Excel 复制）：首行为列名，后续为数据行
 * 2. MySQL 边框格式（+----+------+ 分隔线 + | 管道符）
 *
 * 输出标准 INSERT INTO table (col1, col2) VALUES (...), (...); 语句。
 */

import type { Transform, TransformContext, TransformResult } from "./types";

/** 解析结果 */
interface TableData {
  columns: string[];
  rows: string[][];
}

/** 检测是否为 MySQL 边框格式 */
const BORDER_RE = /^\+[-+]+\+$/;
const PIPE_RE = /^\|(.+)\|$/;

/** 解析 MySQL 边框格式 */
function parseBordered(lines: string[]): TableData | null {
  const dataLines = lines.filter((l) => PIPE_RE.test(l.trim()));
  if (dataLines.length < 2) return null; // 至少表头 + 1 行数据

  const parseRow = (l: string): string[] =>
    l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  const columns = parseRow(dataLines[0]);
  const rows = dataLines.slice(1).map(parseRow);

  // 列数一致性检查
  if (rows.some((r) => r.length !== columns.length)) return null;
  return { columns, rows };
}

/** 解析 Tab 分隔格式 */
function parseTabSeparated(lines: string[]): TableData | null {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null; // 至少表头 + 1 行数据

  // 必须含 tab
  if (!nonEmpty[0].includes("\t")) return null;

  const columns = nonEmpty[0].split("\t").map((c) => c.trim());
  if (columns.length < 2) return null; // 至少 2 列才有意义

  const rows = nonEmpty.slice(1).map((l) => l.split("\t").map((c) => c.trim()));
  // 列数一致性（允许尾部空列）
  const valid = rows.every((r) => r.length >= columns.length - 1);
  if (!valid) return null;

  return { columns, rows: rows.map((r) => r.slice(0, columns.length)) };
}

/** 解析表格文本 */
export function parseTable(text: string): TableData | null {
  const lines = text.split(/\r?\n/);
  // 优先尝试边框格式
  if (lines.some((l) => BORDER_RE.test(l.trim()))) {
    return parseBordered(lines);
  }
  // 再尝试 tab 分隔
  return parseTabSeparated(lines);
}

/** 判断值是否需要引号（非纯数字、非 NULL） */
function needsQuote(v: string): boolean {
  if (v.toUpperCase() === "NULL" || v === "") return false;
  return !Number.isFinite(Number(v));
}

/** 转义 SQL 字符串 */
function escapeSql(v: string): string {
  return v.replace(/'/g, "''");
}

/** 生成 INSERT 语句 */
export function tableToInsert(table: TableData, tableName: string): string {
  const cols = table.columns.map((c) => `\`${c}\``).join(", ");
  const valueRows = table.rows.map((row) => {
    const vals = row.map((v) => {
      if (v.toUpperCase() === "NULL" || v === "") return "NULL";
      if (needsQuote(v)) return `'${escapeSql(v)}'`;
      return v;
    });
    return `(${vals.join(", ")})`;
  });
  return `INSERT INTO \`${tableName}\` (${cols}) VALUES\n${valueRows.join(",\n")};`;
}

function ok(output: string, meta?: { count?: number }): TransformResult {
  return { ok: true, output, ...(meta ? { meta } : {}) };
}

/** detect：文本看起来像表格数据 */
function detect(ctx: TransformContext): number {
  const text = ctx.text;
  // 边框格式
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => BORDER_RE.test(l.trim())) && lines.some((l) => PIPE_RE.test(l.trim()))) {
    return 0.9;
  }
  // Tab 分隔多行多列
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length >= 2 && nonEmpty[0].includes("\t")) {
    const colCount = nonEmpty[0].split("\t").length;
    if (colCount >= 2) return 0.8;
  }
  return 0;
}

export const queryResultToSqlTransform: Transform = {
  id: "query-result-to-sql",
  label: "表格 → INSERT",
  description: "将查询结果表格（Tab 分隔 / MySQL 边框）转为 INSERT 语句",
  icon: "table",
  group: "sql",
  detect,
  options: [
    {
      key: "table",
      label: "表名",
      values: [{ value: "my_table", label: "my_table" }],
      default: "my_table",
    },
  ],
  /** 动态选项：如果首行看起来像列名，提示用户确认表名 */
  run: (text, opts) => {
    const table = parseTable(text);
    if (!table) return { ok: false, message: "未识别到表格数据（需 Tab 分隔或 MySQL 边框格式）" };
    const tableName = String(opts?.table || "my_table");
    const sql = tableToInsert(table, tableName);
    return ok(sql, { count: table.rows.length });
  },
};
