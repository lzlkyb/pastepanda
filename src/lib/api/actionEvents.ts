/**
 * 动作使用日志 API（v6.0 第一步：action_events 表）。
 *
 * 只记录「动作 id + 内容类型 + 来源应用 + 时段 + 结果」，
 * **不含任何内容文本**——后端表里根本没有那些字段，前端也不该传。
 *
 * 数据只存本机、保留 90 天，可在设置里查看与一键清空（路线图红线②）。
 * 后端仅 `log / stats / clear` 三个命令；统计是「自进化」的数据源，
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

/** 场景权重的一行（v6.2 来源+时段感知）：某内容类型下某动作在某场景的使用频次 */
export interface SceneWeightRow {
  actionId: string;
  contentType: string;
  /** work(9-17) / evening(18-23) / night(0-8) */
  hourBucket: string;
  /** ide / browser / terminal / chat / other */
  sourceCat: string;
  count: number;
}

/** 一条「不再推荐这个」负反馈（v6.1） */
export interface ActionDismissal {
  actionId: string;
  /** 空串 = 该动作在哪儿都不推荐 */
  contentType: string;
  createdAt: string;
}

// ===== 会话内的“上一个动作” =====

/** 最近一次动作（供序列推荐用）；进程内存，不落盘 */
let lastAction: { id: string; at: number } | null = null;

/**
 * 上一个动作的有效期。
 *
 * 必须与 Rust 端 `sequence_memory.rs` 的 `SESSION_GAP_SECS`（10 分钟）一致：
 * 后端挖转移表时超过这个间隔就当两段互不相干的操作，前端这边如果放得更宽，
 * 就会拿“半小时前那个动作”去查一张**根本不包含跨会话对**的表，永远查不中；
 * 放得更窄则白白漏掉真实的连续操作。
 */
export const LAST_ACTION_TTL_MS = 10 * 60 * 1000;

/** 会话内的上一个动作 id；超时或从未有过返回 null */
export function lastActionId(): string | null {
  if (!lastAction) return null;
  return Date.now() - lastAction.at <= LAST_ACTION_TTL_MS ? lastAction.id : null;
}

/** 仅供测试：清掉会话内的上一个动作 */
export function __resetLastActionForTest(): void {
  lastAction = null;
}

/**
 * 记一笔。**fire-and-forget**：写不进去也只是少一条统计，
 * 绝不能拖慢或打断复制/粘贴本身。
 *
 * 顺带维护会话内的“上一个动作”——全项目写 action_events 只有这一个入口，
 * 放在这里才不会漏掉某个调用点。
 */
export function logActionEvent(event: ActionEvent): void {
  // paste 哨兵不能当“上一个动作”：它是动作的**结果**不是意图，
  // 而且后端挖转移表时已经把它排除了——这边不排的话，每次粘贴都会把
  // lastAction 冲成 "paste"，而那个 key 在表里根本不存在，序列加成永远不生效。
  if (event.actionId !== "paste") {
    lastAction = { id: event.actionId, at: Date.now() };
  }
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

/** 场景权重：近 N 天按 (动作 × 内容类型 × 时段桶 × 来源类别) 的使用频次（v6.2） */
export async function actionRecommendSceneWeights(days?: number): Promise<SceneWeightRow[]> {
  return invoke("action_recommend_scene_weights", { days });
}

/** 记一条「不再推荐这个」；contentType 传空串 = 在哪儿都不推荐 */
export async function actionDismissAdd(actionId: string, contentType: string): Promise<void> {
  return invoke("action_dismiss_add", { actionId, contentType });
}

/** 全部负反馈列表 */
export async function actionDismissals(): Promise<ActionDismissal[]> {
  return invoke("action_dismissals");
}

/** 恢复一条「不再推荐」（自进化弹窗的恢复按钮）；contentType 空串 = 该动作全部恢复 */
export async function actionDismissRemove(actionId: string, contentType: string): Promise<number> {
  return invoke("action_dismiss_remove", { actionId, contentType });
}

/** 一键清空全部学习记录（事件 + 负反馈），返回删除条数 */
export async function actionLearningsClear(): Promise<number> {
  return invoke("action_learnings_clear");
}
