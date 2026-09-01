/**
 * 笔记列表（知识模式中栏）。从 KnowledgeView 拆出：加上文件夹树与第三栏后，
 * 全塞在一个文件里必破规则 #7（单 tsx ≤300 行）。
 *
 * 右键菜单复用项目现有的 `CtxMenuCtx`（Provider 由 KnowledgeView 提供——
 * 注意 `CardList` 里那个只在记录模式渲染）。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback, useContext } from "react";
import { Trash2, FolderInput, Library } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { relativeTime } from "@/lib/utils";
import type { Note, NoteFolder } from "@/lib/api";
import styles from "../KnowledgeView.module.css";

/** 正文摘要：抖掉换行与 Markdown 行首标记，只留一行可读的文字。 */
export function excerpt(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function NoteList({
  notes,
  folders,
  activeId,
  showFolderColumn,
  onOpen,
  onDelete,
  onSetFolder,
}: {
  notes: Note[];
  /** 给「移动到文件夹」菜单用 */
  folders: NoteFolder[];
  /** 当前在第三栏里打开的那条（窄屏下永远为 null） */
  activeId: string | null;
  /** 侧栏收起时在每行末尾显示所属文件夹（否则列表没上下文） */
  showFolderColumn: boolean;
  onOpen: (note: Note) => void;
  onDelete: (note: Note) => void;
  onSetFolder: (note: Note, folderId: string | null) => void;
}) {
  const ctxTrigger = useContext(CtxMenuCtx);

  const folderName = useCallback(
    (id: string | null) => folders.find((f) => f.id === id)?.name ?? "未分类",
    [folders],
  );

  const buildMenu = useCallback(
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

      const items: MenuItem[] = [];
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
    [folders, onDelete, onSetFolder],
  );

  return (
    <ul className={styles.list}>
      {notes.map((note) => (
        <li
          key={note.id}
          className={`${styles.row} ${activeId === note.id ? styles.rowActive : ""}`}
          onContextMenu={(e) => {
            if (!ctxTrigger) return;
            e.preventDefault();
            ctxTrigger(e.clientX, e.clientY, buildMenu(note));
          }}
        >
          <button type="button" className={styles.rowMain} onClick={() => onOpen(note)}>
            <span className={styles.rowTitle}>{note.title}</span>
            <span className={styles.rowExcerpt}>{excerpt(note.content)}</span>
            <span className={styles.rowMeta}>
              <span className={styles.rowTime}>{relativeTime(note.updated_at)}</span>
              {note.tags.map((tag) => (
                <span key={tag.id} className={styles.tagChip} style={{ borderColor: tag.color }}>
                  {tag.name}
                </span>
              ))}
              {/* 侧栏收起时才显所属文件夹：展开时树里已经高亮着了，重复信息 */}
              {showFolderColumn && (
                <span className={styles.rowFolder}>{folderName(note.folder_id)}</span>
              )}
            </span>
          </button>
          <button
            type="button"
            className={styles.rowDelete}
            title="删除笔记"
            aria-label={`删除笔记 ${note.title}`}
            onClick={() => onDelete(note)}
          >
            <Trash2 size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
