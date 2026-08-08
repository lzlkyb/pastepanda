/**
 * AI / 联网 / 会先思考 —— 三种小标记的**唯一实现**。
 *
 * 为什么要抽成组件：同一个标记至少要出现在三处——变换卡片、模型芯片、
 * 以及路线图 v6.0 要前置到卡片上的动作条。抽之前它已经开始分叉了：
 * 一处是内联 JSX，另一处是拼在字符串里的纯文本。
 *
 * 命名与目录跟随仓库既有的 `SourceBadge` / `TagBadge`，不新造目录。
 */

import { Sparkles, Cloud, Clock } from "lucide-react";
import styles from "./AiBadge.module.css";

export type AiBadgeKind = "ai" | "remote" | "thinking";

interface Props {
  /**
   * - `ai`：这是一个 AI 能力（唯一用强调色的一种）
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
    <span className={`${styles.badge} ${styles[kind]} ${size === "xs" ? styles.xs : ""}`} title={title}>
      <Icon size={size === "xs" ? 9 : 10} />
      {text}
    </span>
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
