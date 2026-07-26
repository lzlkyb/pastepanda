/**
 * transforms/columnSqlIn.ts — 一列值 → SQL IN（P0 功能 #1）。
 *
 * 场景：从查询结果 / 表格里竖着复制一列 ID（每行一个），直接拼成 IN (...)。
 * 复用 jsonToolbox.toSqlIn 的引号 / 转义 / 包裹逻辑，仅新增"按列文本"输入源。
 */

import { toSqlIn, type SqlInOptions } from "@/lib/jsonToolbox";
import { parseColumnList } from "./detectors";
import type { Transform, TransformContext, TransformResult } from "./types";

export const columnToSqlInTransform: Transform = {
  id: "column-to-sql-in",
  label: "SQL IN（按列）",
  description: "每行一个值 → IN (...)",
  icon: "rows",
  group: "sql",
  detect(ctx: TransformContext): number {
    const info = parseColumnList(ctx.text);
    if (!info.ok) return 0;
    // 行数越多越像列数据，0.5 起步、封顶 0.9
    return Math.min(0.5 + info.count * 0.05, 0.9);
  },
  run(text: string, opts?: Record<string, unknown>): TransformResult {
    const info = parseColumnList(text);
    if (!info.ok) return { ok: false, message: "不是按列的值文本（需每行一个值，至少两行）" };
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
