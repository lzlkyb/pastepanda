/**
 * jsonFormatTransform.ts — JSON 格式化（v6.4 M1 · 动作链步骤之一）。
 *
 * 校验并缩进美化 JSON。作为独立变换加入枢纽，同时是动作链「JSON 清洗」的步骤。
 * 纯本地、零依赖：parse → stringify(2 空格缩进)。
 */

import type { Transform, TransformContext } from "./types";

/** 粗判"看起来像 JSON"：以 { 或 [ 开头（trim 后）。只用于排序，不决定成败。 */
function looksLikeJson(ctx: TransformContext): boolean {
  const s = ctx.text.trim();
  if (s.startsWith("{") && s.endsWith("}")) return true;
  if (s.startsWith("[") && s.endsWith("]")) return true;
  return false;
}

export const jsonFormatTransform: Transform = {
  id: "json_format",
  label: "JSON 格式化",
  description: "校验并缩进美化 JSON",
  icon: "code",
  group: "json",
  detect: (ctx) => (looksLikeJson(ctx) ? 0.8 : 0),
  run: (text) => {
    try {
      const parsed = JSON.parse(text);
      return { ok: true, output: JSON.stringify(parsed, null, 2) };
    } catch {
      return { ok: false, message: "不是合法的 JSON" };
    }
  },
};
