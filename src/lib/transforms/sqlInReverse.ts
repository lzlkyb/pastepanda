/**
 * transforms/sqlInReverse.ts — SQL IN 反向拆解。
 *
 * 从 `WHERE id IN ('a','b','c')` 或 `IN (1,2,3)` 中提取值列表，
 * 输出为每行一个值（方便粘贴到 Excel）或 JSON 数组。
 * 场景：从别人发的 SQL / 日志里提取 ID 列表做二次处理。
 */

import type { Transform, TransformContext, TransformResult } from "./types";

/** 匹配 IN (...) 子句（贪婪到最后一个右括号） */
const IN_RE = /\bIN\s*\(([^)]+)\)/i;

/** 解析 IN 子句内的值列表 */
function parseInValues(inner: string): string[] {
  const values: string[] = [];
  // 按逗号分割，但尊重引号内的逗号
  let current = "";
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      inQuote = ch;
    } else if (ch === ",") {
      const trimmed = current.trim();
      if (trimmed) values.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) values.push(last);
  return values;
}

/** 从文本中提取 IN 子句的值 */
export function extractInValues(text: string): { values: string[]; allNumeric: boolean } | null {
  const match = text.match(IN_RE);
  if (!match) return null;
  const values = parseInValues(match[1]);
  if (values.length === 0) return null;
  const allNumeric = values.every((v) => Number.isFinite(Number(v)));
  return { values, allNumeric };
}

function ok(output: string, meta?: { count?: number }): TransformResult {
  return { ok: true, output, ...(meta ? { meta } : {}) };
}

/** detect：文本包含 IN (...) 模式 */
function detect(ctx: TransformContext): number {
  if (!IN_RE.test(ctx.text)) return 0;
  const result = extractInValues(ctx.text);
  if (!result || result.values.length < 2) return 0;
  // 值越多越确定
  return Math.min(0.7 + result.values.length * 0.02, 0.95);
}

/** 输出格式选项 */
const outputOptions = {
  key: "format",
  label: "输出格式",
  values: [
    { value: "lines", label: "每行一个" },
    { value: "json", label: "JSON 数组" },
    { value: "comma", label: "逗号分隔" },
  ],
  default: "lines",
};

export const sqlInReverseTransform: Transform = {
  id: "sql-in-reverse",
  label: "拆解 IN 列表",
  description: "从 SQL IN (...) 中提取值列表",
  icon: "list",
  group: "sql",
  detect,
  options: [outputOptions],
  run: (text, opts) => {
    const result = extractInValues(text);
    if (!result) return { ok: false, message: "未找到 IN (...) 子句" };
    const { values } = result;
    const format = opts?.format ?? "lines";
    let output: string;
    if (format === "json") {
      output = JSON.stringify(values, null, 2);
    } else if (format === "comma") {
      output = values.join(", ");
    } else {
      output = values.join("\n");
    }
    return ok(output, { count: values.length });
  },
};
