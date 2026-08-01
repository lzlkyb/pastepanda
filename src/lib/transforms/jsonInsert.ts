/**
 * transforms/jsonInsert.ts — JSON 数组 → INSERT 语句（P0 功能 #2）。
 *
 * 场景：开发造测试数据时，把接口返回的对象数组直接转成批量 INSERT。
 * - 对象数组 [{id:1,name:"a"},{id:2,name:"b"}]
 *     → INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b');
 * - 标量数组 [1,2,3]（单列，列名可配，默认 value）
 *     → INSERT INTO t (value) VALUES (1), (2), (3);
 *
 * 字面量格式化复用 jsonToolbox.toSqlLiteral（引号 / 转义 / NULL / 布尔），
 * 字段顺序复用 parseJsonArray 的首次出现顺序，保证与 SQL IN 行为一致。
 */

import { extractArrayFromJson, toSqlLiteral } from "@/lib/jsonToolbox";
import type { Transform, TransformContext, TransformResult } from "./types";

/** INSERT 生成选项 */
export interface InsertOptions {
  /** 表名，默认 "table_name" */
  table?: string;
  /** 字符串引号风格，默认单引号 */
  quote?: "single" | "double" | "backtick";
  /** 引号翻倍转义，默认开启 */
  escape?: boolean;
  /** 标量数组使用的列名，默认 "value" */
  scalarColumn?: string;
}

/** jsonToInsert 的返回结构 */
export interface InsertResult {
  ok: boolean;
  sql?: string;
  message?: string;
  /** 生成的数据行数 */
  count?: number;
}

const QUOTE_CHAR: Record<NonNullable<InsertOptions["quote"]>, string> = {
  single: "'",
  double: '"',
  backtick: "`",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把 JSON 数组文本转成 INSERT 语句。
 * 对象数组按字段并集生成多列；标量数组生成单列。
 */
export function jsonToInsert(text: string, opts: InsertOptions = {}): InsertResult {
  const info = extractArrayFromJson(text);
  if (!info.ok) {
    const message =
      info.reason === "invalid-json" ? "JSON 解析失败" :
      info.reason === "not-array" ? "未找到可用的 JSON 数组（顶层数组或对象内的数组字段）" :
      "数组为空，无法生成 INSERT";
    return { ok: false, message };
  }

  const table = opts.table?.trim() || "table_name";
  const quote = QUOTE_CHAR[opts.quote ?? "single"];
  const escape = opts.escape ?? true;

  if (info.elemType === "object") {
    const columns = info.fields;
    if (columns.length === 0) return { ok: false, message: "对象数组没有可写入的字段" };
    const rows: string[] = [];
    for (const item of info.values) {
      const obj = isPlainObject(item) ? item : {};
      const lits = columns.map((c) => toSqlLiteral(obj[c] ?? null, quote, escape) ?? "NULL");
      rows.push(`(${lits.join(", ")})`);
    }
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rows.join(", ")};`;
    return { ok: true, sql, count: rows.length };
  }

  // 标量数组：单列
  const col = opts.scalarColumn?.trim() || "value";
  const tuples: string[] = [];
  for (const v of info.values) {
    const lit = toSqlLiteral(v, quote, escape);
    if (lit !== null) tuples.push(`(${lit})`);
  }
  if (tuples.length === 0) return { ok: false, message: "没有可转换的值" };
  const sql = `INSERT INTO ${table} (${col}) VALUES ${tuples.join(", ")};`;
  return { ok: true, sql, count: tuples.length };
}

export const jsonInsertTransform: Transform = {
  id: "json-insert",
  label: "INSERT 语句",
  description: "JSON 数组 → INSERT INTO ...",
  icon: "table",
  group: "json",
  detect(ctx: TransformContext): number {
    // 优先读预分析特征，回退直接解析（兼容测试手动构造 ctx）
    const info = ctx.features?.json?.arrayInfo ?? extractArrayFromJson(ctx.text);
    if (!info.ok) return 0;
    // INSERT 对对象数组（多列）价值最高
    let score = info.elemType === "object" ? 0.8 : 0.5;
    if (info.sourceField) score -= 0.05;
    return score;
  },
  run(text: string, opts?: Record<string, unknown>): TransformResult {
    const r = jsonToInsert(text, (opts ?? {}) as InsertOptions);
    if (!r.ok || !r.sql) return { ok: false, message: r.message };
    return { ok: true, output: r.sql, meta: { count: r.count } };
  },
  options: [
    {
      key: "quote",
      label: "引号",
      values: [
        { value: "single", label: "单引号" },
        { value: "double", label: "双引号" },
        { value: "backtick", label: "反引号" },
      ],
      default: "single",
    },
  ],
};
