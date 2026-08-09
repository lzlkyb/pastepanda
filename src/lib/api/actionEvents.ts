/**
 * 动作使用日志 API（v6.0 第一步：action_events 表）。
 *
 * 只记录「动作 id + 内容类型 + 来源应用 + 时段 + 结果」，
 * **不含任何内容文本**——后端表里根本没有那些字段，前端也不该传。
 *
 * 数据只存本机、保留 90 天，可在设置里查看与一键清空（路线图红线②）。
 * 后端仅 `log / stats / clear` 三个命令；统计是「系统学到了什么」的数据源，
 * v6.1 起由设置页消费。
 */
import { invoke } from "@tauri-apps/api/core";
import { cleanSourceName } from "@/lib/utils";

/** outcome 取值（与后端 data_store/action_events.rs 的常量一一对应） */
export type ActionOutcome = "copied" | "pasted" | "abandoned";

export interface ActionEvent {
  actionId: string;
  /** 内容类型（json / code / text …），与变换上下文一致 */
  contentType: string;
  /** 来源应用（SOURCE_MAP 规范化后的名字），未知传空串 */
  sourceApp: string;
  /** 0–23，本机时间 */
  hour: number;
  outcome: ActionOutcome;
  /** 关联的历史条目 id。粘贴信号回写必填（actionId="paste"）；动作事件可省略 */
  historyId?: string;
}

export interface ActionEventCount {
  actionId: string;
  count: number;
}

export interface ActionEventStats {
  days: number;
  total: number;
  copied: number;
  pasted: number;
  abandoned: number;
  /** 使用最多的动作，按次数降序 */
  topActions: ActionEventCount[];
}

/** 个性化权重的一行（v6.1）：某内容类型下某动作的使用频次 */
export interface ActionWeightRow {
  actionId: string;
  contentType: string;
  count: number;
}

/** 一条「不再推荐这个」负反馈（v6.1） */
export interface ActionDismissal {
  actionId: string;
  /** 空串 = 该动作在哪儿都不推荐 */
  contentType: string;
  createdAt: string;
}

/**
 * 记一笔。**fire-and-forget**：写不进去也只是少一条统计，
 * 绝不能拖慢或打断复制/粘贴本身。
 */
export function logActionEvent(event: ActionEvent): void {
  void invoke("action_event_log", { event }).catch(() => {
    /* 静默：统计是补充，不是主流程 */
  });
}

/**
 * 粘贴信号回写（v6.1）：主列表/卡片粘贴成功后调用。
 *
 * 粘贴 = 内容真正被用上，是「按价值清理」（自我净化）与个性化权重的关键信号。
 * actionId 用 `paste` 哨兵（不是真实变换动作，后端权重聚合会排除它），
 * 并带上 history_id 关联到具体条目。
 */
export function logPasteEvent(
  historyId: string,
  contentType: string,
  sourceApp: string,
): void {
  logActionEvent({
    actionId: "paste",
    contentType,
    sourceApp: cleanSourceName(sourceApp),
    hour: new Date().getHours(),
    outcome: "pasted",
    historyId,
  });
}

/** 最近 N 天的事件统计（默认 30 天） */
export async function actionEventStats(days?: number): Promise<ActionEventStats> {
  return invoke("action_event_stats", { days });
}

/** 清空全部事件，返回删除条数（红线②：一键清空） */
export async function actionEventClear(): Promise<number> {
  return invoke("action_event_clear");
}

// ===== v6.1：个性化推荐数据 =====

/** 个性化权重：近 N 天按 (动作 × 内容类型) 的使用频次（默认 14 天） */
export async function actionRecommendWeights(days?: number): Promise<ActionWeightRow[]> {
  return invoke("action_recommend_weights", { days });
}

/** 记一条「不再推荐这个」；contentType 传空串 = 在哪儿都不推荐 */
export async function actionDismissAdd(actionId: string, contentType: string): Promise<void> {
  return invoke("action_dismiss_add", { actionId, contentType });
}

/** 全部负反馈列表 */
export async function actionDismissals(): Promise<ActionDismissal[]> {
  return invoke("action_dismissals");
}

/** 一键清空全部学习记录（事件 + 负反馈），返回删除条数 */
export async function actionLearningsClear(): Promise<number> {
  return invoke("action_learnings_clear");
}
