/**
 * ai/quickTypes.ts —— AI 快捷区的共享类型。
 *
 * 单独成文件是因为 AiQuickBar / AiQuickActions / AiQuickResult / useAiQuickRun
 * 四处都要用 ActionState，放在任一个组件里都会造成环引用。
 */
import type { TransformResultMeta } from "@/lib/transforms";

/** 结果元信息显式类型（extends 保持与宽松 TransformResultMeta 的双向兼容） */
export interface QuickMeta extends TransformResultMeta {
  model?: string;
  cached?: boolean;
  truncated?: boolean;
  needsConfirm?: boolean;
  budgetExceeded?: boolean;
}

export interface ActionState {
  status: "idle" | "loading" | "done" | "confirm" | "error";
  output?: string;
  message?: string;
  meta?: QuickMeta;
  /** 错误分类：来自 aiRun 三态的 meta 或本地判定，属结构化信息——勿回到用 message.includes 猜错误类型 */
  errKind?: "budget" | "notReady" | "other";
  /** 结果卡是否收起（头部常驻，正文/操作折叠） */
  collapsed?: boolean;
  /** 流式：loading 期间的增量缓冲（打字机渲染） */
  streamText?: string;
  /** 追问：多轮问题/答案（一一对应） */
  followQs?: string[];
  followAs?: string[];
  followPending?: boolean;
  /** 回退：已还原到原文 */
  reverted?: boolean;
}

export const EMPTY_ACTION_STATE: ActionState = { status: "idle" };
