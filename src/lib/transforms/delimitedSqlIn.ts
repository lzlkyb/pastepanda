/**
 * transforms/delimitedSqlIn.ts — 单行分隔值 → SQL IN。
 *
 * 场景：从接口文档 / 聊天记录 / 邮件里复制一串逗号（或分号、竖线）分隔的 ID，
 * 直接拼成 IN (...)。与 columnSqlIn（多行每行一个）互补：
 * - columnSqlIn 处理竖列（\n 分隔）
 * - delimitedSqlIn 处理横排（, ; | 分隔）
 *
 * 检测逻辑：单行（或极少行）+ 含 ≥2 个一致分隔符 + 非自然语言句子。
 */

import { toSqlIn, type SqlInOptions } from "@/lib/jsonToolbox";
import type { Transform, TransformContext, TransformResult } from "./types";

/** 支持的分隔符（按优先级） */
const DELIMITERS = [",", ";", "|", "，"] as const; // 最后一个是中文逗号

/** 解析结果 */
interface DelimitedInfo {
  ok: boolean;
  values: string[];
  delimiter: string;
  count: number;
}

/**
 * 尝试把文本按某种分隔符拆成值列表。
 * 判定规则：
 * - 文本行数 ≤ 3（允许尾部换行）
 * - 某种分隔符出现 ≥ 2 次
 * - 拆出的每个片段 trim 后非空、不含内部空格（排除自然语言）
 *   放宽：允许数字/字母/下划线/连字符/点/中文组成的"值"
 */
function parseDelimited(text: string): DelimitedInfo {
  const fail: DelimitedInfo = { ok: false, values: [], delimiter: "", count: 0 };

  const trimmed = text.trim();
  if (!trimmed) return fail;

  // 行数检查：允许最多 3 行（有时复制带尾部换行或两行拼接）
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 3) return fail;

  // 合并为单行（多行时用空格拼接，统一处理）
  const single = lines.join(" ");

  for (const delim of DELIMITERS) {
    const parts = single.split(delim);
    if (parts.length < 3) continue; // 至少 3 个值（2 个分隔符）

    const values = parts.map((p) => p.trim()).filter((p) => p.length > 0);
    if (values.length < 3) continue;

    // 排除自然语言：值不应包含多个空格（"hello world" 不像 ID）
    const allSimple = values.every((v) => !/\s{2,}/.test(v) && v.length <= 100);
    if (!allSimple) continue;

    // 排除：如果大部分值包含中文且长度 > 10，可能是句子被逗号分割
    const longChinese = values.filter((v) => /[\u4e00-\u9fff]/.test(v) && v.length > 10);
    if (longChinese.length > values.length * 0.5) continue;

    return { ok: true, values, delimiter: delim, count: values.length };
  }

  return fail;
}

export const delimitedSqlInTransform: Transform = {
  id: "delimited-to-sql-in",
  label: "SQL IN（分隔值）",
  description: "逗号/分号/竖线分隔 → IN (...)",
  icon: "list",
  group: "sql",
  detect(ctx: TransformContext): number {
    const info = ctx.features?.delimited ?? parseDelimited(ctx.text);
    if (!info.ok) return 0;
    // 值越多越像数据列表，0.55 起步、封顶 0.88
    return Math.min(0.55 + info.count * 0.03, 0.88);
  },
  run(text: string, opts?: Record<string, unknown>): TransformResult {
    const info = parseDelimited(text);
    if (!info.ok) {
      return { ok: false, message: "未识别到分隔值（需逗号/分号/竖线分隔，至少 3 个值）" };
    }
    const sql = toSqlIn(info.values, (opts ?? {}) as SqlInOptions);
    if (!sql) return { ok: false, message: "没有可转换的值" };
    return { ok: true, output: sql, meta: { count: info.count } };
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
    {
      key: "wrap",
      label: "包裹",
      values: [
        { value: "in", label: "IN" },
        { value: "paren", label: "括号" },
        { value: "values", label: "VALUES" },
      ],
      default: "in",
    },
  ],
};
