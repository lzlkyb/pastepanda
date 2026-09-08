/**
 * 笔记的右键 / ⋯ 菜单。从 `NoteList.tsx` 搬出来的（2026-09-07）。
 *
 * 为何搬：第三栏头部要加一个 `⋯`（C 稿 §7），而 `NoteDetailPane` 拿不到
 * 住在列表组件里的 `buildMenu`。把菜单在那边再写一份就是第二份真相：
 * 置顶文案、删除该不该带 danger、「未分类」该不该出现、排序与分隔线
 * 迟早两边分歧（规则 #11）。
 *
 * ❗ 谁调它：**只有 `KnowledgeView`**，调一次，结果往下传。
 *   不让 `NoteList` / `NoteDetailPane` 各自调——那样得给后者新增
 *   folders / onSetFolder / onDelete / onTogglePin 四个 props，
 *   而它本来是个只管「一条笔记」的组件；而且 hook 也就又有了两个调用点。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback } from "react";
import { Trash2, FolderInput, Library, Pin, PinOff } from "lucide-react";
import type { MenuItem } from "@/components/ContextMenu";
import type { Note, NoteFolder } from "@/lib/api";

export interface NoteMenus {
  /** 仅文件夹列表。行悬停条上那个「移动」按钮与 M 快捷键用。 */
  folderMenu: (note: Note) => MenuItem[];
  /** 完整菜单（置顶 / 移动到文件夹 / 删除）。右键与 `⋯` 共用。 */
  buildMenu: (note: Note) => MenuItem[];
}

export function useNoteMenu({
  folders,
  onSetFolder,
  onDelete,
  onTogglePin,
}: {
  folders: NoteFolder[];
  onSetFolder: (note: Note, folderId: string | null) => void;
  onDelete: (note: Note) => void;
  onTogglePin: (note: Note) => void;
}): NoteMenus {
  /** 「移动到……」的文件夹列表。
   *
   * 单抽出来是因为它有**两个**消费者（规则 #11）：
   * 右键菜单里的「移动到文件夹」子菜单，与悬停动作条上的移动按钮。
   * 写两份的后果是两边的排序 / 分隔线 / 「未分类」该不该出开始分歧。
   */
  const folderMenu = useCallback(
    (note: Note): MenuItem[] => {
      const children: MenuItem[] = [];
      // 已在未分类的不给「移回未分类」
      if (note.folder_id !== null) {
        children.push({
          icon: <Library size={13} />,
          label: "未分类",
          onClick: () => onSetFolder(note, null),
        });
      }
      for (const f of folders) {
        if (f.id === note.folder_id) continue; // 当前所在的不用列
        children.push({
          icon: <FolderInput size={13} />,
          label: f.name,
          onClick: () => onSetFolder(note, f.id),
          separator: children.length === 1 && note.folder_id !== null,
        });
      }
      return children;
    },
    [folders, onSetFolder],
  );

  const buildMenu = useCallback(
    (note: Note): MenuItem[] => {
      const children = folderMenu(note);

      const items: MenuItem[] = [];
      // 置顶（B1）摆最上面：它是可逆、无害、高频的那一个，
      // 而删除在最下面且带 danger——菜单里的风险梯度从上到下递增。
      items.push({
        icon: note.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        label: note.pinned ? "取消置顶" : "置顶",
        onClick: () => onTogglePin(note),
      });
      if (children.length > 0) {
        items.push({
          icon: <FolderInput size={14} />,
          label: "移动到文件夹",
          children,
        });
      }
      items.push({
        icon: <Trash2 size={14} />,
        label: "删除笔记",
        onClick: () => onDelete(note),
        danger: true,
        separator: items.length > 0,
      });
      return items;
    },
    [folderMenu, onDelete, onTogglePin],
  );

  return { folderMenu, buildMenu };
}
