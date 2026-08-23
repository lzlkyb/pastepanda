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
  /**
   * 粘的是当前列表的第几条（0-based）。**仅 paste 写**（v6.15）。
   *
   * `-1` = 不是从列表浏览选的（如从语义搜索结果里直接粘）。
   * 这个区分存在本身就有信息量：-1 的占比 = “搜索 vs 浏览”的比例。
   */
  pasteIndex?: number;
  /** 目标应用类别（往哪去，不是从哪来）。**仅 paste 写** */
  targetCat?: string;
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
  listIndex?: number,
): void {
  // v6.15：多带两个字段（粘的第几条 + 往哪类应用粘）。
  //
  // 为何要这两个：X3（目标应用感知重排）隐含一个未验证的假设——“用户唤起后需要在列表里找”。
  // 如果实际上平均下标接近 0（都粘第一条），那重排根本不必做。
  // 先量一周再决定，比直接写 1-2 天的重排逻辑便宜得多。
  //
  // targetCat 在这里自己拉而不让调用方传：它需要一次 IPC，而四个调用点都不关心这事。
  // 时序上安全：粘贴完成后前台已切回目标应用，而 `last_foreground_hwnd` 也还存着。
  void (async () => {
    let targetCat: string | undefined;
    try {
      const { pastePrecheck } = await import("./paste");
      targetCat = (await pastePrecheck()).targetCategory ?? undefined;
    } catch {
      /* 拉不到就不带，统计少一个维度而已 */
    }
    logActionEvent({
      actionId: "paste",
      contentType,
      sourceApp: cleanSourceName(sourceApp),
      hour: new Date().getHours(),
      outcome: "pasted",
      historyId,
      pasteIndex: listIndex,
      targetCat,
    });
  })();
}

/**
 * 按历史条目回写粘贴信号 —— **所有「粘贴了一条历史记录」的入口都该走这个**。
 *
 * 存在的理由是防同一类 bug 复发：`contentType` 要 `content_type || type`、
 * `sourceApp` 要传 `item.source`，这两条以前在每个调用点各写一遍，
 * 于是漏一个分支就少一类信号（v6.15 修过一次「image/rich/file 三个分支全漏」，
 * 而托盘弹窗 / 快捷面板 / 热键粘贴 / 编辑器四类入口当时并没被发现，一直没记）。
 *
 * @param listIndex 粘的是当前列表第几条（0-based）；无列表位置（栈序、编辑器内）传 -1
 */
export function logItemPasted(
  item: { id: string; type: string; content_type?: string | null; source: string },
  listIndex?: number,
): void {
  logPasteEvent(item.id, item.content_type || item.type, item.source, listIndex);
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

/**
 * 一键清空全部学习记录（事件 + 负反馈），返回删除条数。
 *
 * **不含置顶**：置顶是用户显式设的偏好，不是学习产物（同偏好指令）。
 */
export async function actionLearningsClear(): Promise<number> {
  return invoke("action_learnings_clear");
}

// ===== v6.14：常用置顶（正向偏好） =====

/** 一条「常用置顶」。与 [`ActionDismissal`] 一正一负。 */
export interface ActionPin {
  actionId: string;
  /** 空串 = 全局置顶（本版只用全局） */
  contentType: string;
  createdAt: string;
}

/**
 * 置顶一个动作（幂等）。contentType 传空串 = 全局置顶。
 *
 * 后端会顺手清掉该动作的「不再推荐」，前端不用再调一次 remove。
 */
export async function actionPinAdd(actionId: string, contentType = ""): Promise<void> {
  return invoke("action_pin_add", { actionId, contentType });
}

/** 全部置顶列表 */
export async function actionPins(): Promise<ActionPin[]> {
  return invoke("action_pins");
}

/** 取消置顶。**精确匹配**：contentType 空串只删全局那一条，不是通配符 */
export async function actionPinRemove(actionId: string, contentType = ""): Promise<number> {
  return invoke("action_pin_remove", { actionId, contentType });
}
