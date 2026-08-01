/**
 * transforms/sqlIn.ts — 把已有的 JSON → SQL IN 能力包装成注册表里的 Transform。
 *
 * 这是"完整迁移、不留两套机制"的样板：逻辑仍住在 jsonToolbox.ts，
 * 这里只做适配（detect 评分 + run 结果整形），供变换枢纽统一调度。
 */

import { extractArrayFromJson, pickDefaultField, sqlInFromJson, type SqlInOptions, type ExtractedArrayInfo } from "@/lib/jsonToolbox";
import type { Transform, TransformContext, TransformOptionSpec, TransformResult } from "./types";

const QUOTE_OPTS = [
  { value: "single", label: "单引号" },
  { value: "double", label: "双引号" },
  { value: "backtick", label: "反引号" },
];

const WRAP_OPTS = [
  { value: "in", label: "IN" },
  { value: "paren", label: "括号" },
  { value: "values", label: "VALUES" },
];

/** 从 features 或回退直接解析获取数组信息 */
function getArrayInfo(ctx: TransformContext): ExtractedArrayInfo {
  return ctx.features?.json?.arrayInfo ?? extractArrayFromJson(ctx.text);
}

export const sqlInTransform: Transform = {
  id: "sql-in",
  label: "SQL IN",
  description: "JSON 数组 / 对象内数组 → IN (...)",
  icon: "database",
  group: "json",
  detect(ctx: TransformContext): number {
    const info = getArrayInfo(ctx);
    if (!info.ok) return 0;
    // 对象数组需要提字段，确定性略低；对象内提取比顶层数组再略低
    let score = info.elemType === "object" ? 0.85 : 0.95;
    if (info.sourceField) score -= 0.05; // 从对象字段提取，稍降权
    return score;
  },
  run(text: string, opts?: Record<string, unknown>): TransformResult {
    const r = sqlInFromJson(text, (opts ?? {}) as SqlInOptions);
    if (!r.ok || !r.sql) {
      return { ok: false, message: r.message, meta: { count: r.info.count } };
    }
    return { ok: true, output: r.sql, meta: { count: r.info.count } };
  },
  options: [
    { key: "quote", label: "引号", values: QUOTE_OPTS, default: "single" },
    { key: "wrap", label: "包裹", values: WRAP_OPTS, default: "in" },
  ],
  // 动态选项：对象数组时额外给出「字段」chip（可选值来自实际字段，默认挑 id 类字段，
  // 与 run → sqlInFromJson 的 pickDefaultField 兜底一致）；标量数组无字段可选则不显示。
  optionsFor(ctx: TransformContext): TransformOptionSpec[] {
    const specs: TransformOptionSpec[] = [];
    const info = getArrayInfo(ctx);
    if (info.ok && info.elemType === "object" && info.fields.length > 0) {
      specs.push({
        key: "field",
        label: "字段",
        values: info.fields.map((f) => ({ value: f, label: f })),
        default: pickDefaultField(info.fields) ?? info.fields[0],
      });
    }
    specs.push(
      { key: "quote", label: "引号", values: QUOTE_OPTS, default: "single" },
      { key: "wrap", label: "包裹", values: WRAP_OPTS, default: "in" },
    );
    return specs;
  },
};
