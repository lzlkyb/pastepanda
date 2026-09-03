/**
 * 笔记 API — 知识库 A 阶段（规划 §8.1 3️⃣）
 *
 * 对应 src-tauri/src/commands/notes.rs。失败一律日志 + toast，**不静默**（规则 #15.3）：
 * 写入类返回 false / null，调用方据此决定要不要关弹窗——否则保存失败却弹窗关了，
 * 用户刚写的正文就没了。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Tag } from "@/stores/appStore";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import type { FolderFilter } from "./noteFolders";
import type { NoteViewOpts } from "@/lib/notes/viewOpts";

/** 一条笔记。字段名与 Rust 结构体一致（snake_case，未过 serde rename）。 */
export interface Note {
  id: string;
  /** 来源卡片 id。null = 独立新建的笔记（B1 才做入口） */
  history_id: string | null;
  title: string;
  /** Markdown 正文。`[[..]]` 原样保存不解析（D7 归 C 阶段） */
  content: string;
  created_at: string;
  updated_at: string;
  /** D13：外部 agent 写入标记。M4 才启用，手动笔记是空串 */
  source_agent: string;
  /** 所属文件夹（B1 #1）。null = 未分类。删文件夹时自动变 null，笔记不会被删 */
  folder_id: string | null;
  /** 一行 AI 摘要。null = 从未生成；空串 = 生成过但用户清掉了 */
  summary: string | null;
  /** 今日速记的日期（`YYYY-MM-DD`）。null = 普通笔记。
   *  这是速记的**身份**，不是标题——标题用户可以改成任意字 */
  daily_date: string | null;
  tags: Tag[];
  /** 当前分组下的**组名**（B2 #9）。null = 不分组。
   *  不是表里的列，是查询时算的；存的已经是可显示的字符串
   *  （文件夹名 / 标签名 / `2026-09`），前端不需要再解析 id */
  group_key?: string | null;
  /** W1 软删除时刻。正常列表拿到的永远是 null（已删的根本不会返回），
   *  只有 `noteListDeleted`（回收站）会给出非 null 的值 */
  deleted_at?: string | null;
  /** 置顶（B1）。**在它所处的分组里排最前**，不分组时就是全局最前。 */
  pinned?: boolean;
  /**
   * 原剪贴板卡片的内容类型（W1b）。与 `deleted_at` 同一个模式：
   * **只有 `noteListDeleted` 会给出非空值**。
   *
   * ❗ 它与 `history_id` 要**一起**看，因为两种不同情况都是空：
   * - `history_id` 为空 ⇒ 这条不是从卡片来的（手工/速记/AI 新建），**不该显类型**；
   * - `history_id` 非空但本字段为空 ⇒ 原卡片**已被删**，应显「来自卡片（已删）」。
   */
  source_kind?: string | null;
}

/** 新建笔记。`historyId` 为空 = 与剪贴板无关的独立笔记。 */
export async function noteCreate(
  historyId: string | null,
  title: string,
  content: string,
): Promise<Note | null> {
  try {
    const note = await invoke<Note>("note_create", { historyId, title, content });
    // 新增的笔记带来一个新的「已转过」卡片 → 同步角标集合，
    // 否则卡片上的 📝 要等下一次全量刷新才出现。
    if (note.history_id) useAppStore.getState().addNoteHistoryId(note.history_id);
    return note;
  } catch (e) {
    logger.error("创建笔记失败", e);
    toastActionFailed("创建笔记", e);
    return null;
  }
}

/** 一次改笔记的附带结果（O-9）。 */
export interface NoteUpdateReport {
  /**
   * 因**标题变化**而被重写了 `[[旧标题]]` 的其它笔记数。
   *
   * wiki 链按标题存，不重写就全断了。重写了就必须告知：
   * 用户只改了一个标题，却有几篇别的笔记的正文被动了。
   */
  relinked: number;
}

/** 改标题与正文。返 `null` = 失败（错已弹过）。 */
export async function noteUpdate(
  id: string,
  title: string,
  content: string,
): Promise<NoteUpdateReport | null> {
  try {
    return await invoke<NoteUpdateReport>("note_update", { id, title, content });
  } catch (e) {
    logger.error("保存笔记失败", e);
    toastActionFailed("保存笔记", e);
    return null;
  }
}

/**
 * 删笔记——**软删除**（W1），进回收站，可用 `noteRestoreDeleted` 找回。
 * 来源卡片不受影响。
 *
 * `historyId` 是可选的优化参：传了就能立即抹掉卡片角标。但它**不能直接信**——
 * 同一张卡片可能转过多条笔记，删一条不等于角标该消失，所以还得回问一次后端。
 */
export async function noteDelete(id: string, historyId?: string | null): Promise<boolean> {
  try {
    await invoke("note_delete", { id });
    if (historyId) {
      const remaining = await invoke<Note | null>("note_by_history", { historyId });
      if (!remaining) useAppStore.getState().removeNoteHistoryId(historyId);
    }
    return true;
  } catch (e) {
    logger.error("删除笔记失败", e);
    toastActionFailed("删除笔记", e);
    return false;
  }
}

/** 回收站条数（侧栏计数用）。不能拿 `noteListDeleted().length` 代替：
 *  那会为了一个数字把 200 条笔记正文都拉回来。 */
export async function noteCountDeleted(): Promise<number> {
  try {
    return await invoke<number>("note_count_deleted");
  } catch (e) {
    logger.warn("读取回收站条数失败", e);
    return 0;
  }
}

/** 回收站列表，按删除时间倒序（W1）。 */
export async function noteListDeleted(limit = 200): Promise<Note[]> {
  try {
    return await invoke<Note[]>("note_list_deleted", { limit });
  } catch (e) {
    logger.error("读取回收站失败", e);
    toastActionFailed("读取回收站", e);
    return [];
  }
}

/**
 * 切换置顶（B1）。返回切完之后的状态；失败返回 `null`（api 层已弹错）。
 *
 * ❗ 后端**不会动 `updated_at`**，所以置顶不会把笔记推到「最近修改」最前。
 *   列表里的位置变化完全来自 `ORDER BY notes.pinned DESC`。
 */
export async function noteTogglePin(id: string): Promise<boolean | null> {
  try {
    return await invoke<boolean>("note_toggle_pin", { id });
  } catch (e) {
    logger.error("切换置顶失败", e);
    toastActionFailed("切换置顶", e);
    return null;
  }
}

/**
 * 从回收站恢复。
 *
 * 速记有个真实的失败情形：当天已经有另一条速记时后端会报错（唯一索引）。
 * 那句错误是人话，直接给用户看，不要吞。
 */
export async function noteRestoreDeleted(id: string, historyId?: string | null): Promise<boolean> {
  try {
    await invoke("note_restore_deleted", { id });
    // 与 `noteDelete` 对称：删的时候抹掉了卡片角标，恢复就得把它加回去。
    // 不需要像删除那样回问后端：恢复成功就意味着这张卡片确实又有笔记了。
    if (historyId) useAppStore.getState().addNoteHistoryId(historyId);
    return true;
  } catch (e) {
    logger.error("恢复笔记失败", e);
    toastActionFailed("恢复笔记", e);
    return false;
  }
}

/**
 * 从回收站彻底销毁（连历史快照一起，**不可恢复**）。
 *
 * ❗ 调用方必须先弹确认。这是笔记侧唯一一个真正不可逆的操作——
 *   普通删除只是进回收站，这个不是。
 */
export async function notePurge(id: string): Promise<boolean> {
  try {
    await invoke("note_purge", { id });
    return true;
  } catch (e) {
    logger.error("销毁笔记失败", e);
    toastActionFailed("销毁笔记", e);
    return false;
  }
}

/**
 * 清空回收站（R4）。返回销毁条数，失败返回 `null`。
 *
 * ❗ 同样不可恢复，调用方必须先弹确认，而且确认文案要带具体条数。
 */
export async function notePurgeAll(): Promise<number | null> {
  try {
    return await invoke<number>("note_purge_all");
  } catch (e) {
    logger.error("清空回收站失败", e);
    toastActionFailed("清空回收站", e);
    return null;
  }
}

/**
 * 按给定天数算「回收站会被销毁多少条」，**不删任何东西**。
 *
 * 设置页把保留天数改短时用它填二次确认。统计失败返回 `null`——
 * 调用方应该**照弹确认**，只是不显示具体数字（不能因为统计失败就静默改）。
 */
export async function noteCountExpired(days: number): Promise<number | null> {
  try {
    return await invoke<number>("note_count_expired", { days });
  } catch (e) {
    logger.warn("统计回收站超期条数失败", e);
    return null;
  }
}

/**
 * 记一笔「这条笔记被打开阅读了」（B2 前置，为 §8.3 #7 重现的「久未访问」攒数据）。
 *
 * **「什么算一次访问」的定义就在这里**（规则 #11）：用户**打开一条已存在的笔记**。
 * 两个调用点：知识库里点开一条（KnowledgeView.handleOpen）、
 * 点已转过的卡片跳到它的笔记（openNoteForCard 的 existing 分支）。
 * **新建不算**（还没开始读），**今日速记追加不算**（那是写不是读）。
 *
 * fire-and-forget：失败不提示也不阻断打开，同 `logActionEvent` 的口径。
 * 后端只改 `last_access_at`，**不碰 `updated_at`**（看一眼不是改一次）。
 */
export function noteTouch(id: string): void {
  void invoke("note_touch", { id }).catch(() => {
    /* 统计写不进去不该影响用户，后端已记 warn */
  });
}

/** 按 id 取一条（带标签）。 */
export async function noteGet(id: string): Promise<Note | null> {
  try {
    return await invoke<Note | null>("note_get", { id });
  } catch (e) {
    logger.error("读取笔记失败", e);
    return null;
  }
}

/**
 * 笔记列表，`updated_at` 降序。
 *
 * `folderFilter` / `tagIds` 是**交集**关系（设计稿 §4）；文件夹取具体 id 时含全部后代。
 */
export async function noteList(
  opts: {
    folderFilter?: FolderFilter;
    tagIds?: string[];
    /** 字段视图（B2 #9）。不传 = 默认态 = 与做这个功能之前一模一样 */
    view?: NoteViewOpts;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Note[]> {
  try {
    return await invoke<Note[]>("note_list", {
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
      view: opts.view ?? null,
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
    });
  } catch (e) {
    logger.error("获取笔记列表失败", e);
    return [];
  }
}

/**
 * 当前筛选下的笔记总数。
 *
 * 与 `noteList` 共用后端的同一个筛选构造，所以不会出现「计数说 225 而列表只有 200」。
 */
export async function noteCountFiltered(
  opts: { folderFilter?: FolderFilter; tagIds?: string[]; view?: NoteViewOpts } = {},
): Promise<number> {
  try {
    return await invoke<number>("note_count_filtered", {
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
      view: opts.view ?? null,
    });
  } catch (e) {
    logger.warn("统计笔记数失败", e);
    return 0;
  }
}

/**
 * 每个分组的**真实**条数（B2 #9）。不分组时后端返回空数组。
 *
 * ❗ 组头的数字必须走这里，**不能数已加载的行**：列表是分页拉的，
 * 数已加载的行就会得到「组头写 12 条而实际 20 条」。
 */
export async function noteGroupCounts(
  opts: { folderFilter?: FolderFilter; tagIds?: string[]; view?: NoteViewOpts } = {},
): Promise<Map<string, number>> {
  try {
    const rows = await invoke<{ key: string; count: number }[]>("note_group_counts", {
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
      view: opts.view ?? null,
    });
    return new Map(rows.map((r) => [r.key, r.count]));
  } catch (e) {
    // 不阻断列表：拿不到数时组头不显数字，而不是整个分组视图挂掉。
    // 也不能退化成「数已加载的行」——那是拿假数字冒充真数字。
    logger.warn("统计分组条数失败", e);
    return new Map();
  }
}

/**
 * 某张卡片已转的笔记（最新一条）。这就是「重复转笔记 → 幂等」的依据：
 * 非空就直接编辑它，不再建第二份。
 */
export async function noteByHistory(historyId: string): Promise<Note | null> {
  try {
    return await invoke<Note | null>("note_by_history", { historyId });
  } catch (e) {
    logger.error("查询卡片对应笔记失败", e);
    return null;
  }
}

/**
 * 拉全量「已转过笔记的卡片 id」并写进 store，供卡片列表渲染 📝 角标。
 *
 * 一次 IPC 拿全集，而不是逐张卡片查（一屏几十张 = 几十次 IPC）。
 */
export async function fetchNoteHistoryIds(): Promise<string[]> {
  try {
    const ids = await invoke<string[]>("note_history_ids");
    useAppStore.getState().setNoteHistoryIds(ids);
    return ids;
  } catch (e) {
    logger.error("获取笔记角标集失败", e);
    return [];
  }
}

/**
 * 搜笔记。关键词为空 = 返回列表首页。
 *
 * **筛选条件会叠上**：选着文件夹搜索时，用户的预期是「在这个文件夹里搜」，
 * 而不是结果突然跳出当前范围。
 */
export async function noteSearch(
  keyword: string,
  opts: {
    folderFilter?: FolderFilter;
    tagIds?: string[];
    view?: NoteViewOpts;
    limit?: number;
  } = {},
): Promise<Note[]> {
  try {
    return await invoke<Note[]>("note_search", {
      keyword,
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
      view: opts.view ?? null,
      limit: opts.limit ?? 50,
    });
  } catch (e) {
    logger.error("搜索笔记失败", e);
    return [];
  }
}

/**
 * 问答检索（B2 #10）：一句自然语言问题 → 按**相关度**的几篇笔记。
 *
 * 与 {@link noteSearch} 分开是必须的：那边是 AND 语义，一整句问题丢进去
 * 零命中是必然的（理由见后端 `question_to_or_expr` 的注释）。
 *
 * 🔴 **故意让异常抛出去**，不像 {@link noteSearch} 那样 catch 成 `[]`：
 * 问答里的空数组会被展示成「知识库中没有相关笔记」——把检索失败
 * 伪装成「你库里没这个」是个**看不出来的错答案**（规则 #15.3）。
 */
export async function noteSearchRelevant(
  question: string,
  opts: {
    folderFilter?: FolderFilter;
    tagIds?: string[];
    view?: NoteViewOpts;
    /** 默认 5 = `QA_TOP_K`（定义在 lib/notes/kbQa.ts，不从 api 层反向依赖它） */
    limit?: number;
  } = {},
): Promise<Note[]> {
  return await invoke<Note[]>("note_search_relevant", {
    question,
    folderFilter: opts.folderFilter ?? "all",
    tagIds: opts.tagIds ?? [],
    view: opts.view ?? null,
    limit: opts.limit ?? 5,
  });
}

/** 整组替换笔记标签（空数组 = 清空）。 */
export async function noteSetTags(noteId: string, tagIds: string[]): Promise<boolean> {
  try {
    await invoke("note_set_tags", { noteId, tagIds });
    return true;
  } catch (e) {
    logger.error("设置笔记标签失败", e);
    toastActionFailed("设置笔记标签", e);
    return false;
  }
}

/** 笔记总数。 */
export async function noteCount(): Promise<number> {
  try {
    return await invoke<number>("note_count");
  } catch (e) {
    logger.error("统计笔记数失败", e);
    return 0;
  }
}
