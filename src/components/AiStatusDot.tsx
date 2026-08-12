/**
 * AiStatusDot.tsx —— 审查方案 1：已配置用户的 AI 状态绿点（收在设置按钮右上角）。
 *
 * 顶部零额外占用：6px 小绿点即"AI 已就绪"；hover 显示本周用量与模型详情。
 * 未配置/缺密钥时不显示（那些状态仍由 AiStatusCap 引流胶囊承担）。
 */
import { memo } from "react";
import { useAiStatus } from "@/hooks/useAiStatus";
import styles from "./AiStatusDot.module.css";

export const AiStatusDot = memo(function AiStatusDot() {
  const { status, weekCalls, model } = useAiStatus();
  if (status !== "on") return null;
  return (
    <span
      className={styles.dot}
      title={`AI 已就绪 · 本周使用 ${weekCalls} 次 · ${model}`}
      aria-label="AI 已就绪"
    />
  );
});
