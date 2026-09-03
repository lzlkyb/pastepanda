/**
 * 笔记列表（知识模式中栏）。从 KnowledgeView 拆出：加上文件夹树与第三栏后，
 * 全塞在一个文件里必破规则 #7（单 tsx ≤300 行）。
 *
 * 右键菜单复用项目现有的 `CtxMenuCtx`（Provider 由 KnowledgeView 提供——
 * 注意 `CardList` 里那个只在记录模式渲染）。
 *
 * 🔴 红线：无 AI。
 */
import { Fragment, useCallback, useContext, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Trash2, FolderInput, Library, Pin, PinOff } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { TagBadge, TagBadgeMore } from "@/components/TagBadge";
import { relativeTime, countChars, fmtCount } from "@/lib/utils";
import { excerpt, excerptAround, highlight } from "@/lib/notes/excerpt";
import type { Note, NoteFolder } from "@/lib/api";
import { groupHeaderFor } from "@/lib/notes/viewOpts";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import styles from "../KnowledgeView.module.css";

// `excerpt` 已移到 `@/lib/notes/excerpt`（连带高亮与带关键词的摘要）。
// 本文件超了规则 #7 的 300 行，而那两个函数是纯函数、也被 TrashPanel 用。

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
  keyword,
  onTagClick,
  selectedIds,
  onRowSelect,
  onClearSelection,
  onOpen,
  onDelete,
  onSetFolder,
  onTogglePin,
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
  /** 当前搜索词（B3）。只用于高亮与把摘要截到命中处，不参与查询。 */
  keyword: string;
  /** 点行内标签 = 切换该标签的筛选（A1）。 */
  onTagClick: (tagId: string) => void;
  /** 已选中的笔记 id（A2）。 */
  selectedIds: Set<string>;
  /** 带修饰键的选择。`range` = 从锚点连选到这一条。 */
  onRowSelect: (index: number, mode: "toggle" | "range") => void;
  onClearSelection: () => void;
  onOpen: (note: Note) => void;
  onDelete: (note: Note) => void;
  onSetFolder: (note: Note, folderId: string | null) => void;
  /** 切换置顶（B1）。 */
  onTogglePin: (note: Note) => void;
}) {
  const ctxTrigger = useContext(CtxMenuCtx);

  /**
   * 键盘导航（roving tabindex）。
   *
   * 🔴 改之前这个列表**一点键盘支持都没有**：每行两个 `<button>`，
   *   50 行就是 **100 个 Tab 停靠点**才能走完列表，而且没有 ↑↓ 选择。
   *   roving 的做法：只有当前行 `tabIndex=0`，其余 -1——Tab 一下进列表、
   *   一下出列表，列内用方向键。
   */
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);

  // 焦点索引跟着「第三栏里打开的那条」走：鼠标点开一条后再按 ↓，
  // 应该从那一条继续，而不是从上一次键盘停的地方。
  useEffect(() => {
    if (!activeId) return;
    const i = notes.findIndex((n) => n.id === activeId);
    if (i >= 0) setFocusIdx(i);
  }, [activeId, notes]);

  // 列表变短（搜索 / 换文件夹 / 删除）后把索引拉回范围内，
  // 否则 roving 会指向一个不存在的行，整个列表就没有 tabIndex=0 的元素了。
  useEffect(() => {
    setFocusIdx((i) => (i < notes.length ? i : Math.max(0, notes.length - 1)));
  }, [notes.length]);

  const moveTo = useCallback(
    (next: number) => {
      const i = Math.max(0, Math.min(next, notes.length - 1));
      setFocusIdx(i);
      rowRefs.current[i]?.focus();
    },
    [notes.length],
  );

  /** 列表级键盘。Enter 不用接——行本身就是 `<button>`，那是原生行为。 */
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(focusIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveTo(focusIdx - 1);
          break;
        case "Home":
          e.preventDefault();
          moveTo(0);
          break;
        case "End":
          e.preventDefault();
          moveTo(notes.length - 1);
          break;
        case "Delete": {
          // 走与鼠标同一个确认框，不另开一条「键盘删除」的路。
          // ❗ 有选中时不接：那该走批量删除（动作条上那个），
          //   否则选了 12 条按 Delete 却只删了光标那一条，是最坏的那种意外。
          if (selectedIds.size > 0) break;
          const n = notes[focusIdx];
          if (n) {
            e.preventDefault();
            onDelete(n);
          }
          break;
        }
        case "Escape":
          // 清选中。没选中时不拦，让 Esc 继续冒泡（外面还有别人在听）。
          if (selectedIds.size > 0) {
            e.preventDefault();
            onClearSelection();
          }
          break;
      }
    },
    [focusIdx, moveTo, notes, onDelete, selectedIds, onClearSelection],
  );

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
    [folders, onDelete, onSetFolder, onTogglePin],
  );

  return (
    // 键盘接在 `<ul>` 上而不是每行上：事件会冒泡上来，一份处理就够，
    // 而且分组头、加载更多哨兵那几个 `<li>` 不需要各自再接一遍。
    <ul className={styles.list} onKeyDown={onListKeyDown}>
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
              index={i}
              active={activeId === note.id}
              selected={selectedIds.has(note.id)}
              anySelected={selectedIds.size > 0}
              selectedIds={selectedIds}
              onRowSelect={onRowSelect}
              keyword={keyword}
              onTagClick={onTagClick}
              focused={focusIdx === i}
              rowRef={(el) => {
                rowRefs.current[i] = el;
              }}
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

/**
 * 拖拽载荷的 MIME。自定义类型而不是 `text/plain`：
 * 后者会让笔记能被拖进任何输入框，而我们只想让它能拖进文件夹。
 */
export const NOTE_DRAG_MIME = "application/x-pastepanda-notes";

/** 单行。从上面拆出来只为了让分组那层 map 还读得动（行为一字未改）。 */
function NoteRow({
  note,
  index,
  active,
  selected,
  anySelected,
  selectedIds,
  onRowSelect,
  keyword,
  onTagClick,
  focused,
  rowRef,
  showFolderColumn,
  folderName,
  buildMenu,
  ctxTrigger,
  onOpen,
  onDelete,
}: {
  note: Note;
  index: number;
  active: boolean;
  selected: boolean;
  /** 列表里有任何选中。决定方框要不要渲染（未进入多选时不占位） */
  anySelected: boolean;
  selectedIds: Set<string>;
  onRowSelect: (index: number, mode: "toggle" | "range") => void;
  keyword: string;
  onTagClick: (tagId: string) => void;
  /** 键盘焦点落在这一行（roving tabindex）。与 `active`（第三栏打开的那条）是两回事 */
  focused: boolean;
  /** 给列表层存行引用用，方向键靠它调 `.focus()` */
  rowRef: (el: HTMLButtonElement | null) => void;
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
      className={`${styles.row} ${active ? styles.rowActive : ""} ${
        selected ? styles.rowSelected : ""
      }`}
      whileHover={{ y: -2, scale: 1.01, transition: { type: "spring", stiffness: 500, damping: 30 } }}
      whileTap={{ scale: 0.985, transition: { duration: 0.08, ease: "easeOut" } }}
      onContextMenu={(e) => {
        if (!ctxTrigger) return;
        e.preventDefault();
        ctxTrigger(e.clientX, e.clientY, buildMenu(note));
      }}
    >
      {/* 选中框。**未进入多选时根本不渲染**：列表日常是「扫着读」，
          每行挂一个永久的方框是对主场景收税。 */}
      {anySelected && (
        <span
          className={`${styles.rowCheck} ${selected ? styles.rowCheckOn : ""}`}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        className={styles.rowMain}
        ref={rowRef}
        /* roving：全列表只有一个 0。 */
        tabIndex={focused ? 0 : -1}
        /* A3 拖拽源。❗ 挂在这个普通 `<button>` 上而不是外层 `motion.li`：
           framer-motion 把 `onDragStart` 当成它自己的手势事件（回调拿到的是
           MouseEvent/PointerEvent，没有 `dataTransfer`），两套拖拽机制同名冲突。

           **拖的是选中集**：拖一条未选中的行就只拖它，拖一条已选中的行就拖整批
           ——与系统文件管理器同口径。 */
        draggable
        onDragStart={(e) => {
          const ids = selected ? [...selectedIds] : [note.id];
          e.dataTransfer.setData(NOTE_DRAG_MIME, JSON.stringify(ids));
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={(e) => {
          // ❗ 普通点击的行为**一字未改**（打开）。多选是叠在修饰键上的能力，
          //   不能拿日常最高频的动作去换。
          if (e.ctrlKey || e.metaKey) {
            onRowSelect(index, "toggle");
          } else if (e.shiftKey) {
            onRowSelect(index, "range");
          } else {
            onOpen(note);
          }
        }}
      >
        {/* 图标底：直接用卡片那一套 `--glass-icon-*` token（见 CSS）。
            它是卡片最强的视觉锚点，而笔记行本来一个图标都没有。 */}
        <span className={styles.rowIcon} title={prov.label} aria-hidden="true">
          {prov.icon}
        </span>
        <span className={styles.rowBody}>
        <span className={styles.rowTitle}>
          {/* 置顶徽标（B1）。摆在标题前而不是行尾：扫列表时眼睛走的是左边缘，
              而「这条被我置顶了」是一眼就要看到的事。 */}
          {note.pinned && <Pin size={10} className={styles.rowPin} aria-label="已置顶" />}
          {highlight(note.title, keyword)}
        </span>
        {/* 有 AI 摘要就用它，没有才回退到正文截断（B1 轻量 AI）。
            扫列表时一行摘要比一段截断的正文有用得多。
            注意用 `note.summary ||` 而不是 `??`：空串（用户清掉过）也该回退。

            搜索时（B3）摆正文而不是摘要：命中在正文里，而 AI 摘要里未必有那个词——
            继续摆摘要就会出现「搜到了但一个高亮也看不到」。 */}
        <span className={styles.rowExcerpt}>
          {keyword.trim()
            ? highlight(excerptAround(note.content, keyword), keyword)
            : note.summary || excerpt(note.content)}
        </span>
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
          {/* A1：行内标签现在**可点** = 切换该标签的筛选。
              ❗ 接的是知识库自己的 `tagIds`，**不是** `TagRow` 那个 `toggleTagFilter`
                （那是记录模式的筛选器，在这里点下去会去筛剪贴板卡片）。
              TagBadge 内部已经 `stopPropagation` + `preventDefault`，
              所以不会连带触发行的「打开笔记」。 */}
          {note.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
            <TagBadge
              key={tag.id}
              tag={tag}
              /* ❗ 不传 `active`：`TagBadge` 的 `active` 只对 `picker` 变体生效（看它的实现），
                 行内用的是 `card` 变体。传一个不生效的 prop 比不传更容易骗人。
                 当前生效的标签靠上面的 chips 行表达，那里是完整的。 */
              onClick={() => onTagClick(tag.id)}
            />
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
        title="删除笔记（Delete）"
        aria-label={`删除笔记 ${note.title}`}
        /* ❗ 必须 -1，否则 roving 白做了——Tab 还是会在列表里停 50 次。
           它仍然可达：行上按 Delete、右键菜单、鼠标悬停。 */
        tabIndex={-1}
        onClick={() => onDelete(note)}
      >
        <Trash2 size={12} />
      </button>
    </motion.li>
  );
}
