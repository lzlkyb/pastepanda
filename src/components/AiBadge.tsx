/**
 * AI / 联网 / 会先思考 —— 三种小标记。
 *
 * 外观已全部委托给 {@link AiMark}（全站 AI 标识的唯一外观实现），
 * 本文件只剩两件事：**哪三种语义**，以及**每种配什么图标与文案**。
 * 不要把颜色/尺寸写回来——同一枚“AI”还出现在顶栏品牌上标、
 * AiStatusCap、AiQuickBar 与 AiOnboarding，写回来就又分叉了。
 *
 * 命名与目录跟随仓库既有的 `SourceBadge` / `TagBadge`。
 */

import { Sparkles, Cloud, Clock } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";

export type AiBadgeKind = "ai" | "remote" | "thinking";

interface Props {
  /**
   * - `ai`：这是一个 AI 能力（唯一用品牌渐变的一种）
   * - `remote`：会联网且可能计费，但不是 AI
   * - `thinking`：提示该模型会先输出思维链
   */
  kind?: AiBadgeKind;
  /** `xs` 给 v6.0 卡片动作条用；默认 `sm` */
  size?: "sm" | "xs";
}

const META: Record<AiBadgeKind, { Icon: typeof Sparkles; text: string; title: string }> = {
  ai: {
    Icon: Sparkles,
    text: "AI",
    title: "AI 动作：需要联网，会把这条内容发送到所选服务商并可能产生费用",
  },
  remote: {
    Icon: Cloud,
    text: "联网",
    title: "需要联网，会把这条内容发送到外部服务并可能产生费用",
  },
  thinking: {
    Icon: Clock,
    text: "会先思考",
    title: "推理模型：回答前先输出一段思考，那些 token 照样计费、也照样占用动作的 token 上限",
  },
};

export function AiBadge({ kind = "ai", size = "sm" }: Props) {
  const { Icon, text, title } = META[kind];
  return (
    <AiMark
      shape="badge"
      // remote / thinking 是**提示**而非**标识**，故意降级为中性，不跟 AI 抢注意力
      tone={kind === "ai" ? "brand" : "neutral"}
      size={size}
      icon={<Icon size={size === "xs" ? 9 : 10} />}
      text={text}
      title={title}
    />
  );
}

/**
 * 从变换推导该写哪个字。**调用方不要自己写三元表达式。**
 *
 * 职责分开的理由：
 * - “显不显示”由 `transform.remote` 决定——那是风险标记，一个都不能漏；
 * - “写什么字”由分组决定——`remote` 是“会联网且可能计费”的通用契约，
 *   并不等于 AI。以后加个短链之类的联网变换，标成 AI 就是说谎。
 */
export function badgeKindOf(t: { group: string }): AiBadgeKind {
  return t.group === "ai" ? "ai" : "remote";
}
