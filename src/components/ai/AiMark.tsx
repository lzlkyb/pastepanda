/**
 * components/ai/AiMark.tsx —— 全站 AI 标识的**唯一外观实现**。
 *
 * 为什么要有它：同一枚“AI”之前散在六处——AiBadge、AiStatusCap、顶栏品牌上标，
 * 还有 AiQuickBar 与 AiOnboarding 两处直接硬写的 `<Sparkles/> AI` 和 `✦ AI 已就绪`。
 * 分叉已经发生过（AiBadge 自己的注释就记着一次），所以把外观收到这里。
 *
 * **本组件零副作用**。这是故意的：AiStatusCap / AiStatusDot 带着 useAiStatus、
 * aiQuotaGet、额度事件订阅，如果把它们一并合进来，连“只想画两个字”的品牌上标
 * 都会被迫发请求、订阅事件（而 hook 不能条件调用，绕不过去）。
 * 所以：**状态留在各自的薄壳里，外观全部委托给它**。
 *
 * 两个正交的轴，不要混：
 * - `tone` = 说什么：`brand` 这是 AI（蓝→紫渐变）、`neutral` 会联网/会先思考
 *   （中性提示，故意不跟 AI 抢注意力）、`warn` 缺密钥/余额不足（警示，
 *   绝不能换成品牌蓝紫——那等于把“还差一步”说成“一切就绪”）；
 * - `shape` = 长什么样：只管盒子与字号，不活语义。
 */

import type { ReactNode } from "react";
import styles from "./AiMark.module.css";

/** 语气：这个标记在说什么 */
export type AiTone = "brand" | "neutral" | "warn";

/**
 * 形态：
 * - `text`  只上渐变，字号继承周围——给句子里的“AI”用（如“AI 已就绪”）；
 * - `sup`   品牌上标（9px/800，贴在产品名后）；
 * - `label` 裸标签（11px/700，图标+文字，无底无边）；
 * - `badge` 小徽章（9.5px，有底有边）；
 * - `cap`   胶囊（22px 高，传 onClick 就是可点入口）。
 */
export type AiShape = "text" | "sup" | "label" | "badge" | "cap";

export interface AiMarkProps {
  tone?: AiTone;
  shape?: AiShape;
  /** 仅 `badge` 有意义：更小一档（v6.0 卡片动作条用） */
  size?: "sm" | "xs";
  /** 图标（可省）。由调用方传入已定尺寸的图标实例 */
  icon?: ReactNode;
  text: string;
  title?: string;
  /** 传了就渲染成 `<button>`（引流胶囊用）；不传是 `<span>` */
  onClick?: () => void;
  className?: string;
}

export function AiMark({
  tone = "brand",
  shape = "badge",
  size = "sm",
  icon,
  text,
  title,
  onClick,
  className,
}: AiMarkProps) {
  const cls = [
    styles.mark,
    styles[shape],
    styles[tone],
    size === "xs" ? styles.xs : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {icon}
      {/* 只有 brand 走渐变字。渐变必须包在**内层 span** 上：
          background-clip:text 征用 background，而外壳的 background
          已经是徽章/胶囊的底色了——两个只能活一个。
          同理图标不能包进去：它是 currentColor 描边的 svg，
          继承到 color:transparent 会直接消失。 */}
      {tone === "brand" ? <span className={styles.grad}>{text}</span> : text}
    </>
  );

  return onClick ? (
    <button type="button" className={cls} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}
