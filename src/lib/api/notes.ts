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

/** 改标题与正文。 */
export async function noteUpdate(id: string, title: string, content: string): Promise<boolean> {
  try {
    await invoke("note_update", { id, title, content });
    return true;
  } catch (e) {
    logger.error("保存笔记失败", e);
    toastActionFailed("保存笔记", e);
    return false;
  }
}

/**
 * 删笔记。来源卡片不受影响。
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
  opts: { folderFilter?: FolderFilter; tagIds?: string[]; limit?: number; offset?: number } = {},
): Promise<Note[]> {
  try {
    return await invoke<Note[]>("note_list", {
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
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
  opts: { folderFilter?: FolderFilter; tagIds?: string[] } = {},
): Promise<number> {
  try {
    return await invoke<number>("note_count_filtered", {
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
    });
  } catch (e) {
    logger.warn("统计笔记数失败", e);
    return 0;
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
  opts: { folderFilter?: FolderFilter; tagIds?: string[]; limit?: number } = {},
): Promise<Note[]> {
  try {
    return await invoke<Note[]>("note_search", {
      keyword,
      folderFilter: opts.folderFilter ?? "all",
      tagIds: opts.tagIds ?? [],
      limit: opts.limit ?? 50,
    });
  } catch (e) {
    logger.error("搜索笔记失败", e);
    return [];
  }
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
