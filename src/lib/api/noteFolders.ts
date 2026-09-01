/**
 * 笔记文件夹 API — B1 #1
 *
 * 对应 src-tauri/src/commands/note_folders.rs。
 * 设计稿：design/PastePanda-知识库视图-设计稿.html
 *
 * ❗ 校验（防环 / 深度 / 重名）**后端才是权威**。前端把非法目标从菜单里去掉
 *   只是为了不让用户选了才报错，不能指望它当守卫。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 一个文件夹。字段名与 Rust 结构体一致。 */
export interface NoteFolder {
  id: string;
  name: string;
  /** null = 顶层 */
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  /** 本文件夹**及其所有后代**里的笔记数（与列表同口径） */
  note_count: number;
  /** 深度，顶层 = 1 */
  depth: number;
}

/**
 * 文件夹筛选值。`"all"` | `"unfiled"` | `<folder_id>`。
 *
 * 这个形状是照搬项目现有的 `GroupFilter`（`"all" | "ungrouped" | string`），
 * 不另发明一套——两个模式的筛选口径得一致。
 */
export type FolderFilter = "all" | "unfiled" | string;

/** 全部文件夹（平表）。前端自己建 parent→children 建树。 */
export async function folderList(): Promise<NoteFolder[]> {
  try {
    return await invoke<NoteFolder[]>("folder_list");
  } catch (e) {
    logger.warn("读取文件夹失败", e);
    return [];
  }
}

/** 未分类笔记数。 */
export async function folderUnfiledCount(): Promise<number> {
  try {
    return await invoke<number>("folder_unfiled_count");
  } catch (e) {
    logger.warn("统计未分类笔记失败", e);
    return 0;
  }
}

/**
 * 深度上限。**从后端拿而不是前端写个 3**：两边各存一份，改一边就会出现
 * 「菜单里能选、点下去报错」或反之。拉失败时给 3（与当前后端值一致）。
 */
export async function folderMaxDepth(): Promise<number> {
  try {
    return await invoke<number>("folder_max_depth");
  } catch (e) {
    logger.warn("读取文件夹深度上限失败，暂用 3", e);
    return 3;
  }
}

/**
 * 删除前的影响预览：`[子文件夹数, 会变未分类的笔记数]`。
 *
 * 确认框拿这两个真数字去填。拉失败返回 null → 调用方应该**不弹确认直接中止**，
 * 而不是弹个没数字的确认框——用户无法据此决定。
 */
export async function folderDeleteImpact(id: string): Promise<[number, number] | null> {
  try {
    return await invoke<[number, number]>("folder_delete_impact", { id });
  } catch (e) {
    logger.error("读取文件夹删除影响失败", e);
    return null;
  }
}

/** 新建文件夹。`parentId` 为 null = 顶层。 */
export async function folderCreate(
  name: string,
  parentId: string | null,
): Promise<NoteFolder | null> {
  try {
    return await invoke<NoteFolder>("folder_create", { name, parentId });
  } catch (e) {
    logger.error("新建文件夹失败", e);
    toastActionFailed("新建文件夹", e);
    return null;
  }
}

/** 重命名。 */
export async function folderRename(id: string, name: string): Promise<boolean> {
  try {
    await invoke("folder_rename", { id, name });
    return true;
  } catch (e) {
    logger.error("重命名文件夹失败", e);
    toastActionFailed("重命名", e);
    return false;
  }
}

/** 移动。`newParent` 为 null = 移到顶层。 */
export async function folderMove(id: string, newParent: string | null): Promise<boolean> {
  try {
    await invoke("folder_move", { id, newParent });
    return true;
  } catch (e) {
    logger.error("移动文件夹失败", e);
    toastActionFailed("移动文件夹", e);
    return false;
  }
}

/** 删除。子文件夹随之删，**笔记不删**（变未分类）。 */
export async function folderDelete(id: string): Promise<boolean> {
  try {
    await invoke("folder_delete", { id });
    return true;
  } catch (e) {
    logger.error("删除文件夹失败", e);
    toastActionFailed("删除文件夹", e);
    return false;
  }
}

/** 给笔记归档。`folderId` 为 null = 移回未分类。 */
export async function noteSetFolder(
  noteId: string,
  folderId: string | null,
): Promise<boolean> {
  try {
    await invoke("note_set_folder", { noteId, folderId });
    return true;
  } catch (e) {
    logger.error("归档笔记失败", e);
    toastActionFailed("移动到文件夹", e);
    return false;
  }
}

/**
 * 把平表建成树，按后端给的顺序（depth → sort_order → name）保持稳定。
 *
 * 放在 api 层而不是组件里：侧栏树与「移动到…」菜单都要建树，写两份就会漂。
 *
 * ❗ **孤岛防御**：如果 parent_id 指向一个不在列表里的 id（理论上不应发生，
 *   后端防了环），把它**当顶层显示**而不是静默丢掉——丢掉就是用户看不见的笔记。
 */
export interface FolderNode extends NoteFolder {
  children: FolderNode[];
}

export function buildFolderTree(flat: NoteFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of flat) byId.set(f.id, { ...f, children: [] });

  const roots: FolderNode[] = [];
  for (const f of flat) {
    const node = byId.get(f.id)!;
    const parent = f.parent_id ? byId.get(f.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // 顶层，或父不在集内的孤岛（宁可错位也不能隐藏）
  }
  return roots;
}
