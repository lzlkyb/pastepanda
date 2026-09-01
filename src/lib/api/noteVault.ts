/**
 * 笔记 Markdown 目录导出 / 导入 API —— B1 #5 / D1。
 *
 * 对应 src-tauri/src/commands/note_vault.rs。
 * 设计稿：design/PastePanda-MD导出导入-设计稿.html。
 *
 * **前端不写任何文件**：只用 dialog 选一个目录，把路径交给后端。
 * N 篇笔记一次 IPC，也不需要 fs 插件的 mkdir 权限。
 *
 * 失败一律日志 + toast，**不静默**（规则 #15.3）。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

export interface ExportReport {
  notes: number;
  folders: number;
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  /** 读失败 / 非 UTF-8 的文件名。空数组 = 一个都没出错 */
  failed: string[];
}

/** 全量导出到目录（可直接当 Obsidian vault 打开）。 */
export async function noteExportDir(dir: string): Promise<ExportReport | null> {
  try {
    return await invoke<ExportReport>("note_export_dir", { dir });
  } catch (e) {
    logger.error("导出笔记目录失败", e);
    toastActionFailed("导出笔记", e);
    return null;
  }
}

/** 从目录导入。**合并语义：只新增与更新，永远不删库里的笔记。** */
export async function noteImportDir(dir: string): Promise<ImportReport | null> {
  try {
    return await invoke<ImportReport>("note_import_dir", { dir });
  } catch (e) {
    logger.error("导入笔记目录失败", e);
    toastActionFailed("导入笔记", e);
    return null;
  }
}

/**
 * 拼成带 frontmatter 的 Markdown 全文（「复制为 Markdown」用）。
 *
 * 传的是**屏幕上的草稿**而不是笔记 id：正在改、还没保存的内容也得能复制。
 * 与导出共用同一个后端生成函数（规则 #11），前端不再自己拼一遍。
 * 失败时返回 null，调用方不要把 null 写进剪贴板。
 */
export async function noteMarkdown(
  title: string,
  content: string,
  tags: string[],
): Promise<string | null> {
  try {
    return await invoke<string>("note_markdown", { title, content, tags });
  } catch (e) {
    logger.error("生成 Markdown 失败", e);
    toastActionFailed("生成 Markdown", e);
    return null;
  }
}
