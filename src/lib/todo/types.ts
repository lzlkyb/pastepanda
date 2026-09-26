/**
 * 待办灵动岛的数据契约。
 *
 * 字段与 `src-tauri/src/todo_island.rs::IslandState` 一一对应（`serde(rename_all = "camelCase")`）；
 * `IslandTask` 对应 `src-tauri/src/todo_tasks.rs::IslandTask`。
 * 改一边必须同步另一边 —— 不匹配时 `invoke` 会**静默**返回 undefined 形态，
 * 表现为岛上数字全是 0，而控制台没有任何报错。
 */
export interface IslandTask {
  /** 所在笔记 id（勾选回写的定位键） */
  noteId: string;
  /** 所在笔记标题（展开列表里区分「这条来自哪」） */
  noteTitle: string;
  /** 正文中的行号，0 起 */
  line: number;
  /** 任务文字（`- [ ] ` 之后的部分，**已剥掉 `@时间` 尾巴**） */
  text: string;
  done: boolean;
  /** 截止时刻（本地时区 Unix 毫秒）。null/undefined = 没写截止时间 */
  dueMs?: number | null;
  /** false = 全天（没写 HH:mm）：只展示「今天到期」，不弹提醒 */
  dueHasTime?: boolean;
  /** 展示用的时间文案（「今天 16:00」「9/28 9:00」） */
  dueLabel?: string | null;
}

export interface IslandState {
  /** 待办总数（全库口径，含已完成） */
  total: number;
  /** 已完成数 */
  done: number;
  /** 收起态右侧那句：下一条要做的；全清时「全部完成」；空库为空串 */
  hint: string;
  /** 未完成任务列表（到期优先排好序、截过上限，上限 50） */
  tasks: IslandTask[];
  /** 已完成任务列表（同一排序与上限）。「已完成」标签页用 */
  doneTasks: IslandTask[];
  /** 到点提醒的那条（提醒态胶囊显示它）。null = 当前没有提醒 */
  dueAlert?: IslandTask | null;
}

/** 灵动岛的五个舞台，与 `src-tauri/src/todo_island_stage.rs::IslandStage` 是同一份账。
 *  size 表（208×32 / 300×40 / 420×240 / 420×280 / 208×32）改一处必须同步另一处。 */
export type IslandStage = "pill" | "peek" | "list" | "compose" | "clear";
