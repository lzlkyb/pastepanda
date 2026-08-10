/**
 * transforms/maskTransform.ts — v6.4 B 粘贴脱敏：内容内嵌敏感信息 → 脱敏版。
 *
 * 场景：复制带 API key/手机号/邮箱/身份证/IP 的内容，粘贴到群聊/工单/文档前，
 * 先出一份「脱敏版」——保留可辨识前缀，遮罩敏感主体。
 *
 * 设计（预览确认避免误伤）：
 * - detect 命中 = 内容里**真的识别出**敏感片段（maskSensitiveText count>0）；
 * - run 产出脱敏文本，变换面板先预览，用户确认后再复制/粘贴——
 *   误伤（人名被当密钥）时用户看到脱敏版自行判断，不会直接替换；
 * - 纯本地规则零 AI 成本，不上云（AI 兜底留待 v6.3 规则不足时再说）。
 */

import { maskSensitiveText } from "@/lib/mask";
import type { Transform, TransformContext, TransformResult } from "./types";

/** 命中分：识别出任何敏感片段都高置信 */
const HIT_SCORE = 0.9;

export const maskTransform: Transform = {
  id: "mask-sensitive",
  label: "粘贴脱敏",
  description: "识别内容里的密钥/手机号/邮箱/身份证/IP，替换为脱敏版",
  icon: "shield",
  group: "text",

  detect(ctx: TransformContext): number {
    if (!ctx.text.trim()) return 0;
    return maskSensitiveText(ctx.text).count > 0 ? HIT_SCORE : 0;
  },

  run(text: string): TransformResult {
    const r = maskSensitiveText(text);
    if (r.count === 0) {
      return { ok: false, message: "没有识别到需要脱敏的敏感信息" };
    }
    return { ok: true, output: r.text };
  },
};
