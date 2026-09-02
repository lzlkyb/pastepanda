/**
 * 笔记列表（知识模式中栏）。从 KnowledgeView 拆出：加上文件夹树与第三栏后，
 * 全塞在一个文件里必破规则 #7（单 tsx ≤300 行）。
 *
 * 右键菜单复用项目现有的 `CtxMenuCtx`（Provider 由 KnowledgeView 提供——
 * 注意 `CardList` 里那个只在记录模式渲染）。
 *
 * 🔴 红线：无 AI。
 */
import { Fragment, useCallback, useContext } from "react";
import { motion } from "framer-motion";
import { Trash2, FolderInput, Library } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { TagBadge, TagBadgeMore } from "@/components/TagBadge";
import { relativeTime, countChars, fmtCount } from "@/lib/utils";
import type { Note, NoteFolder } from "@/lib/api";
import { groupHeaderFor } from "@/lib/notes/viewOpts";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
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

/** 行内最多摆几个标签，剩下的收成 `+N`。
 *
 * 不摆全部：`.rowMeta` 是 flex-wrap，8 个标签会把一行撞成三行，
 * 而行高不齐是扫列表时最费力的一件事。完整标签在第三栏里看。
 * 取 3 而不是 TagRow 的 2：笔记行比卡片宽，而且标签在知识库里是主要分类手段。 */
const MAX_ROW_TAGS = 3;

export function NoteList({
  notes,
  folders,
  activeId,
  showFolderColumn,
  groupCounts,
  hasMore,
  loadingMore,
  onLoadMore,
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
  /** 组名 → **真实**条数（B2 #9）。走后端 GROUP BY，不是数已加载的行 */
  groupCounts: Map<string, number>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
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
      {notes.map((note, i) => {
        // 组头：相邻两行的组键不同时插一个（分组本身已在 SQL 的 ORDER BY 里做过）
        const header = groupHeaderFor(notes, i);
        return (
          <Fragment key={note.id}>
            {header !== null && (
              <li className={styles.groupHead}>
                <span>{header}</span>
                {/* 条数走后端 GROUP BY。拿不到时不显数字，
                    **不能**退化成数已加载的行——那就是拿假数冲真数 */}
                {groupCounts.has(header) && (
                  <span className={styles.groupCount}>{groupCounts.get(header)} 条</span>
                )}
              </li>
            )}
            <NoteRow
              note={note}
              active={activeId === note.id}
              showFolderColumn={showFolderColumn}
              folderName={folderName}
              buildMenu={buildMenu}
              ctxTrigger={ctxTrigger}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          </Fragment>
        );
      })}
      <li>
        <LoadMoreSentinel
          hasMore={hasMore}
          loading={loadingMore}
          onLoadMore={onLoadMore}
          className={styles.loadMore}
        />
      </li>
    </ul>
  );
}

/**
 * 一篇笔记的**来路**（图标 + 悬停解释）。
 *
 * 记录模式的卡片图标编的是**内容类型**（文本/图片/链接/代码……），
 * 而笔记里真正有区分度的是「这条从哪来」——这是知识库独有的维度，
 * 也是 M5 之后才有东西可看的一个维度。
 *
 * 导出的缘由（规则 #11）：回收站需要的正是同一个维度——用户恢复前要判「这是什么」。
 * 在 `TrashPanel` 里再写一份就是两份会分歧的 emoji 表。
 *
 * ❗ `notes.source_agent` 的准确含义是「由 AI **新建**」而不是「被 AI 改过」：
 *   `note_update_from` 只把来源写进**版本快照**（W2 的 `note_revisions.source_agent`），
 *   不动 `notes.source_agent`——那两个是不同的事实（创建者 vs 最近改动者）。
 *   所以文案不能写成「AI 改过」，而是指向版本历史。
 */
export function provenanceOf(note: Note): { icon: string; label: string } {
  if (note.source_agent) {
    const name = note.source_agent.replace(/^agent:/, "");
    return { icon: "🤖", label: `由 ${name} 新建。AI 对已有笔记的修改看版本历史。` };
  }
  if (note.daily_date) return { icon: "📅", label: `今日速记 · ${note.daily_date}` };
  if (note.history_id) return { icon: "📋", label: "由剪贴板卡片转来" };
  return { icon: "📝", label: "手工新建" };
}

/** 单行。从上面拆出来只为了让分组那层 map 还读得动（行为一字未改）。 */
function NoteRow({
  note,
  active,
  showFolderColumn,
  folderName,
  buildMenu,
  ctxTrigger,
  onOpen,
  onDelete,
}: {
  note: Note;
  active: boolean;
  showFolderColumn: boolean;
  folderName: (id: string | null) => string;
  buildMenu: (note: Note) => MenuItem[];
  /** 右键菜单触发器。null = Provider 不在作用域里（那时不弹菜单） */
  ctxTrigger: ((x: number, y: number, items: MenuItem[]) => void) | null;
  onOpen: (note: Note) => void;
  onDelete: (note: Note) => void;
}) {
  const prov = provenanceOf(note);
  const chars = countChars(note.content.trim());
  return (
    // 抬升 / 按压的参数**直接用卡片的**（Card.tsx 那两行），不另定一套——
    // 两套弹簧参数是「风格不统一」的另一种形式。
    // scale 向外长的那 1.5px 靠 `.list` 的左右 2px padding 接住，不然会被滚动容器剪掉。
    <motion.li
      className={`${styles.row} ${active ? styles.rowActive : ""}`}
      whileHover={{ y: -2, scale: 1.01, transition: { type: "spring", stiffness: 500, damping: 30 } }}
      whileTap={{ scale: 0.985, transition: { duration: 0.08, ease: "easeOut" } }}
      onContextMenu={(e) => {
        if (!ctxTrigger) return;
        e.preventDefault();
        ctxTrigger(e.clientX, e.clientY, buildMenu(note));
      }}
    >
      <button type="button" className={styles.rowMain} onClick={() => onOpen(note)}>
        {/* 图标底：直接用卡片那一套 `--glass-icon-*` token（见 CSS）。
            它是卡片最强的视觉锚点，而笔记行本来一个图标都没有。 */}
        <span className={styles.rowIcon} title={prov.label} aria-hidden="true">
          {prov.icon}
        </span>
        <span className={styles.rowBody}>
        <span className={styles.rowTitle}>{note.title}</span>
        {/* 有 AI 摘要就用它，没有才回退到正文截断（B1 轻量 AI）。
            扫列表时一行摘要比一段截断的正文有用得多。
            注意用 `note.summary ||` 而不是 `??`：空串（用户清掉过）也该回退。 */}
        <span className={styles.rowExcerpt}>{note.summary || excerpt(note.content)}</span>
        <span className={styles.rowMeta}>
          <span className={styles.rowTime}>{relativeTime(note.updated_at)}</span>
          {/* 字数条（抄卡片的 `.cardSizeTag`）。卡片那边摆的是字节大小，
              笔记里该看的是**字数**——它回答的是「这条我得读多久」。
              空正文不摆：新建未写的笔记挂个「0 字」只是噪声。
              计数走公共 `countChars`（按码点数，emoji 算 1 个），不用 `.length`。 */}
          {chars > 0 && <span className={styles.rowSize}>{fmtCount(chars)} 字</span>}
          {/* 标签走全应用**唯一**的 TagBadge（规则 #11 公共函数收口）。
              原先这里手搓了一个 `borderColor: tag.color` 的描边 chip，绕过了
              TagBadge 那句「全应用所有标签渲染点都必须经过这里」——后果是淡底/
              hover/主题派生全丢了，而且 `source='auto'` 的🤖标识也不会显。

              用 TagBadge 而不用 TagRow：TagRow 的点击接的是 `toggleTagFilter`，
              那是**记录模式**的筛选器，在知识库里点下去会去筛剪贴板卡片。 */}
          {note.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
            <TagBadge key={tag.id} tag={tag} />
          ))}
          {note.tags.length > MAX_ROW_TAGS && (
            <TagBadgeMore count={note.tags.length - MAX_ROW_TAGS} />
          )}
          {/* 侧栏收起时才显所属文件夹：展开时树里已经高亮着了，重复信息 */}
          {showFolderColumn && (
            <span className={styles.rowFolder}>{folderName(note.folder_id)}</span>
          )}
        </span>
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
    </motion.li>
  );
}
