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
  /**
   * 本次清理掉的**陈旧** `.md`（相对路径）。空数组 = 没删任何文件。
   *
   * 导出侧以前**从不删文件**，于是笔记删掉后 vault 里那份 `.md` 永远留着，
   * 下次导入时把它复活成一条新 id 的笔记。只删带 `pastepanda_id` 且该 id
   * 已不在库里的文件——**用户自己写的 `.md` 不会被动**。
   */
  removed: string[];
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  /**
   * 目录层级超过上限、被**平接到最深一层**的篇数。
   *
   * 平接是设计定的（侧栏 180px 只装得下那么多层），但以前**不告知**：
   * 用户的深目录结构默默消失，而 created/updated 看上去完全正常。
   */
  flattened: number;
  /**
   * 当前的文件夹深度上限，由后端给。
   *
   * ❗ 文案里**不要写死这个数字**：它已经从 3 改到过 4，
   *   而写死的字符串改常量时编译器不会报。
   */
  max_depth: number;
  /**
   * 平接后撞上【同一文件夹 + 同标题】、因而**另建了一条**的文件（相对路径）。
   *
   * 以前这种情况会把先导进来的那篇**覆盖掉**（两篇只剩一篇，
   * 而报告显示「新增 1、更新 1」）。现在宁可出现两条同名笔记也不丢内容。
   */
  collided: string[];
  /**
   * `pastepanda_id` 指向一条**已在回收站**的笔记、因而被**跳过**的文件。
   *
   * 跳过而不是恢复：用户的删除是比这个文件更近的操作，想找回去回收站。
   */
  in_trash: string[];
  /** 失败的文件，形如 `相对路径：原因`。空数组 = 一个都没出错 */
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
