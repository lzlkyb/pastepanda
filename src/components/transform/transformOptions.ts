/**
 * 变换选项的解析助手——枢纽与卡片共用。
 */

import type { Transform, TransformContext, TransformOptionSpec } from "@/lib/transforms";

/** 解析变换的选项规格：动态 optionsFor 优先（选项随输入变化），回退静态 options */
export function specsFor(t: Transform, ctx: TransformContext): TransformOptionSpec[] {
  return t.optionsFor?.(ctx) ?? t.options ?? [];
}

/** 从选项规格生成默认值表 */
export function defaultOptsFromSpecs(specs: TransformOptionSpec[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const spec of specs) if (spec.default) o[spec.key] = spec.default;
  return o;
}
