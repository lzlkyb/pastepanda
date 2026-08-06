/**
 * transforms/sqlTransforms.ts — SQL 格式化与压缩变换。
 *
 * 轻量级纯前端 SQL 格式化：关键字大写、主子句换行、缩进对齐。
 * 不依赖外部 crate/库，覆盖实施人员日常 SQL 美化需求。
 */

import type { Transform, TransformContext, TransformResult } from "./types";

function ok(output: string): TransformResult {
  return { ok: true, output };
}

function fail(message: string): TransformResult {
  return { ok: false, message };
}

/** 检测文本是否像 SQL */
function looksLikeSql(ctx: TransformContext): number {
  // 优先读预分析特征
  if (ctx.features?.sql) return ctx.features.sql.confidence;
  const t = ctx.text.trim().toUpperCase();
  // 以主要 SQL 关键字开头
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/.test(t)) return 0.9;
  // 包含 FROM + WHERE 组合
  if (/\bFROM\b/.test(t) && /\bWHERE\b/.test(t)) return 0.7;
  // contentType 是 code 且包含 SQL 关键字
  if (ctx.contentType === "code" && /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(t)) return 0.6;
  return 0;
}

// ===== SQL 关键字列表 =====

const KEYWORDS_UPPER = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "EXISTS",
  "BETWEEN", "LIKE", "IS", "NULL", "TRUE", "FALSE",
  "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "UNION", "ALL", "INTERSECT", "EXCEPT",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW",
  "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "JOIN", "ON",
  "WITH", "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
  "ASC", "DESC", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CONSTRAINT",
  "INT", "INTEGER", "VARCHAR", "TEXT", "BOOLEAN", "DATE", "TIMESTAMP",
  "DEFAULT", "AUTO_INCREMENT", "UNIQUE", "CHECK",
]);

/** 主关键字（需要换行的） */
const NEWLINE_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "HAVING",
  "LIMIT", "UNION", "UNION ALL", "INTERSECT", "EXCEPT",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN", "CROSS JOIN", "JOIN",
  "WITH",
]);

/** 需要缩进的子关键字 */
const INDENT_KEYWORDS = new Set(["AND", "OR", "ON", "WHEN", "THEN", "ELSE"]);

/**
 * 轻量 SQL 格式化：
 * 1. 关键字大写
 * 2. 主子句前换行
 * 3. AND/OR/ON 缩进
 */
function formatSql(input: string): string {
  // 规范化空白
  let sql = input.replace(/\s+/g, " ").trim();

  // 关键字大写（保守：只替换独立单词）
  sql = sql.replace(/\b([a-zA-Z_]+)\b/g, (match) => {
    const upper = match.toUpperCase();
    return KEYWORDS_UPPER.has(upper) ? upper : match;
  });

  // 在主关键字前插入换行
  // 按长度降序排列，避免 "JOIN" 先匹配而 "LEFT JOIN" 失败
  const sortedKeywords = [...NEWLINE_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const kw of sortedKeywords) {
    // 不在字符串开头添加换行
    const regex = new RegExp(`\\s+(${kw.replace(/\s+/g, "\\s+")})\\b`, "gi");
    sql = sql.replace(regex, `\n${kw}`);
  }

  // AND/OR/ON 缩进
  const lines = sql.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstWord = trimmed.split(/\s/)[0].toUpperCase();
    if (INDENT_KEYWORDS.has(firstWord)) {
      result.push("  " + trimmed);
    } else {
      result.push(trimmed);
    }
  }

  return result.join("\n");
}

/** SQL 压缩：去除多余空白，单行输出 */
function compressSql(input: string): string {
  return input
    .replace(/--.*$/gm, "") // 去行注释
    .replace(/\/\*[\s\S]*?\*\//g, "") // 去块注释
    .replace(/\s+/g, " ")
    .trim();
}

// ===== Transforms =====

const sqlFormat: Transform = {
  id: "sql_format",
  label: "SQL 格式化",
  description: "关键字大写 + 子句换行 + 缩进对齐",
  icon: "database",
  group: "sql",
  detect: looksLikeSql,
  run: (t) => {
    if (!t.trim()) return fail("空文本");
    return ok(formatSql(t));
  },
};

const sqlCompress: Transform = {
  id: "sql_compress",
  label: "SQL 压缩",
  description: "去除注释和多余空白，压缩为单行",
  icon: "minimize",
  group: "sql",
  detect: looksLikeSql,
  run: (t) => {
    if (!t.trim()) return fail("空文本");
    return ok(compressSql(t));
  },
};

const sqlKeywordsUpper: Transform = {
  id: "sql_keywords_upper",
  label: "SQL 关键字大写",
  description: "仅将 SQL 关键字转为大写，不改变格式",
  icon: "case-upper",
  group: "sql",
  detect: looksLikeSql,
  run: (t) => {
    if (!t.trim()) return fail("空文本");
    const result = t.replace(/\b([a-zA-Z_]+)\b/g, (match) => {
      const upper = match.toUpperCase();
      return KEYWORDS_UPPER.has(upper) ? upper : match;
    });
    return ok(result);
  },
};

// ===== 导出 =====

export const sqlTransforms: Transform[] = [sqlFormat, sqlCompress, sqlKeywordsUpper];
