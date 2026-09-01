/**
 * 笔记轻量 AI 产物的写入 API（B1 ＋轻量 AI）。
 *
 * 对应 src-tauri/src/commands/note_ai.rs。
 *
 * 🔴 **这里不调模型**：模型调用走现成的变换枢纽（`getTransform("ai-summarize").run`），
 * 那条路上已经有 `ai_enabled` 门控、出网闸、预算、缓存与用量日志。
 * 本文件只管把拿到的结果写回库里。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 写一行摘要。传 null = 清掉。 */
export async function noteSetSummary(id: string, summary: string | null): Promise<boolean> {
  try {
    await invoke("note_set_summary", { id, summary });
    return true;
  } catch (e) {
    logger.error("保存摘要失败", e);
    toastActionFailed("保存摘要", e);
    return false;
  }
}

/**
 * 把模型输出里的标签追加给笔记，返回**真正新增**的那几个。
 * 解析在后端（容错规则多，需要单测），前端只把原文传过去。
 */
export async function noteAddAiTags(noteId: string, raw: string): Promise<string[] | null> {
  try {
    return await invoke<string[]>("note_add_ai_tags", { noteId, raw });
  } catch (e) {
    logger.error("写入 AI 标签失败", e);
    toastActionFailed("写入标签", e);
    return null;
  }
}

/** 用户确认：把这篇笔记的 AI 标签转成手动标签。 */
export async function noteConfirmAiTags(noteId: string): Promise<boolean> {
  try {
    await invoke("note_confirm_ai_tags", { noteId });
    return true;
  } catch (e) {
    logger.error("确认 AI 标签失败", e);
    toastActionFailed("确认标签", e);
    return false;
  }
}
