/**
 * transforms/delimitedSqlIn.ts — 单行分隔值 → SQL IN。
 *
 * 场景：从接口文档 / 聊天记录 / 邮件里复制一串逗号（或分号、竖线）分隔的 ID，
 * 直接拼成 IN (...)。与 columnSqlIn（多行每行一个）互补：
 * - columnSqlIn 处理竖列（\n 分隔）
 * - delimitedSqlIn 处理横排（, ; | 分隔，允许带外层 [] () {}）
 *
 * 解析与检测共用 detectors.parseDelimitedValues：
 * analyzer 预计算的 features.delimited 也走同一函数，
 * 避开“两套机制修一处漏一处”（外层括号未剥除的 bug 就是这么漏的）。
 */

import { toSqlIn, type SqlInOptions } from "@/lib/jsonToolbox";
import { parseDelimitedValues } from "./detectors";
import type { Transform, TransformContext, TransformResult } from "./types";

export const delimitedSqlInTransform: Transform = {
  id: "delimited-to-sql-in",
  label: "SQL IN（分隔值）",
  description: "逗号/分号/竖线分隔 → IN (...)",
  icon: "list",
  group: "sql",
  detect(ctx: TransformContext): number {
    const info = ctx.features?.delimited ?? parseDelimitedValues(ctx.text);
    if (!info.ok) return 0;
    // 值越多越像数据列表，0.55 起步、封顶 0.88
    return Math.min(0.55 + info.count * 0.03, 0.88);
  },
  run(text: string, opts?: Record<string, unknown>): TransformResult {
    const info = parseDelimitedValues(text);
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
