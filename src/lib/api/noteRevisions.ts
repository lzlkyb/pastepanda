/**
 * 笔记版本快照 API —— B1 #4 / D8。
 *
 * 对应 src-tauri/src/commands/note_revisions.rs。
 * 设计稿：design/PastePanda-版本快照-设计稿.html。
 *
 * **这里没有「存一份快照」的函数**：快照在后端随 `note_update` / `note_restore`
 * 自动发生。前端能主动存就意味着两边各有一套「什么时候该快照」的判断。
 *
 * 失败一律日志 + toast，**不静默**（规则 #15.3）。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import type { Note } from "./notes";

/** 历史列表行。**不带全文**——预览时再单拉那一份。 */
export interface NoteRevisionMeta {
  id: number;
  title: string;
  created_at: string;
  /** 正文字数。给用户认出哪份用（项目无 diff 能力，只能靠时间+字数） */
  char_count: number;
  /** 锚定中：永不被 20 份上限挤掉（W2） */
  pinned: boolean;
  /** 这一版是谁改的。`""` = 你自己；非空形如 `agent:claude-code` */
  source_agent: string;
}

/** 一份完整快照。 */
export interface NoteRevision {
  id: number;
  note_id: string;
  title: string;
  content: string;
  created_at: string;
  pinned: boolean;
  source_agent: string;
}

/**
 * 一篇笔记的历史，新在前。**不含当前版**（当前版在 notes 表）。
 * 失败返回空数组：历史拉不到不应该把编辑器也卡死。
 */
export async function noteRevisionList(noteId: string): Promise<NoteRevisionMeta[]> {
  try {
    return await invoke<NoteRevisionMeta[]>("note_revision_list", { noteId });
  } catch (e) {
    logger.error("读取版本历史失败", e);
    toastActionFailed("读取版本历史", e);
    return [];
  }
}

/** 取单份快照全文。 */
export async function noteRevisionGet(revId: number): Promise<NoteRevision | null> {
  try {
    return await invoke<NoteRevision | null>("note_revision_get", { revId });
  } catch (e) {
    logger.error("读取版本内容失败", e);
    toastActionFailed("读取版本内容", e);
    return null;
  }
}

/**
 * 锚定 / 解除锚定一份快照（W2b）。
 *
 * 解除后那一份**不会立即消失**，而是重新变成普通历史、在后继编辑中被挤出。
 * 这一句必须在界面上说清楚，否则用户看到的是「点了没反应，过一阵它自己不见了」。
 *
 * 返回是否成功：失败时调用方不要把 UI 改成已锚定的样子（否则显示在保护，实际没有）。
 */
export async function noteRevisionPin(revId: number, pinned: boolean): Promise<boolean> {
  try {
    await invoke("note_revision_pin", { revId, pinned });
    return true;
  } catch (e) {
    logger.error("锚定版本失败", e);
    toastActionFailed(pinned ? "锚定版本" : "解除锚定", e);
    return false;
  }
}

/**
 * 恢复到指定快照，返回恢复后的笔记。
 * 后端会**先把当前版存成快照**，所以恢复可撤销。
 */
export async function noteRestore(revId: number): Promise<Note | null> {
  try {
    return await invoke<Note>("note_restore", { revId });
  } catch (e) {
    logger.error("恢复版本失败", e);
    toastActionFailed("恢复版本", e);
    return null;
  }
}
