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
import { FolderInput, Pin, PinOff, MoreHorizontal } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import type { Note, NoteFolder } from "@/lib/api";
import { groupHeaderFor } from "@/lib/notes/viewOpts";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import { NoteRowIcon } from "./NoteRowIcon";
import { NoteItemBody } from "./NoteItemBody";
import { NoteCard } from "./NoteCard";
import type { NoteLayout } from "./useNoteLayout";
import { NOTE_DRAG_MIME } from "@/lib/notes/dragMime";
import styles from "../KnowledgeView.module.css";

// `excerpt` 已移到 `@/lib/notes/excerpt`（连带高亮与带关键词的摘要）。
// 本文件超了规则 #7 的 300 行，而那两个函数是纯函数、也被 TrashPanel 用。

// 标题/摘要/元信息三段与 `MAX_ROW_TAGS` 已移到 `NoteItemBody.tsx`：
// 网格卡片上来后那段有了第二个消费者（规则 #11）。

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
  onTogglePin,
  buildMenu,
  folderMenu,
  layout,
  cols,
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
  /** 切换置顶（B1）。 */
  onTogglePin: (note: Note) => void;
  /** 完整右键菜单。来自 `useNoteMenu`，由 `KnowledgeView` 调一次后下发。 */
  buildMenu: (note: Note) => MenuItem[];
  /** 仅文件夹列表（悬停条上的移动按钮与 M 键用）。与 `buildMenu` 同源。 */
  folderMenu: (note: Note) => MenuItem[];
  /** 生效形态（不是用户偏好）。宽度不够时调用方已经降成 `list` 了 */
  layout: NoteLayout;
  /** 网格列数（列表形态时为 1）。二维键盘导航靠它 */
  cols: number;
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

  // `folderMenu` / `buildMenu` 已搬到 `useNoteMenu.tsx`（2026-09-07）：
  // 第三栏头部的 `⋯` 也要用 `buildMenu`，而 `NoteDetailPane` 拿不到住在
  // 本文件里的东西。现在两者都由 `KnowledgeView` 调一次后当 props 下发。

  /** 列表级键盘。Enter 不用接——行本身就是 `<button>`，那是原生行为。 */
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        // ── 方向键。列表是一维（cols=1），网格是二维 ──
        // 🔴 ↓ 必须跳 **+cols** 而不是 +1：网格下 +1 是向右一格。
        //   设计稿没提这一条，它却把三个新按钮全设了 `tabIndex={-1}`
        //   并宣称「可达性靠快捷键」——不改这里就是把那个论据自己架空了。
        case "ArrowDown":
          e.preventDefault();
          moveTo(focusIdx + cols);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveTo(focusIdx - cols);
          break;
        // ❗ 列表形态下←→**不接**：一维列表里它无意义，
        //   而中栏窄屏时 ← 可能被理解成「回到侧栏」——别去抢一个语义未定的键。
        //   行尾自动跳下一行首（而不是停住）：索引本来就是线性的。
        case "ArrowRight":
          if (cols <= 1) break;
          e.preventDefault();
          moveTo(focusIdx + 1);
          break;
        case "ArrowLeft":
          if (cols <= 1) break;
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
        // ── P / M：悬停动作条那两个正向按钮的键盘路径 ──
        // 动作条里全是 `tabIndex={-1}`（不能让 Tab 在列表里停上百次），
        // 所以可达性必须靠这里——不补就是把功能只给了鼠标。
        case "p":
        case "P": {
          // ❗ 带修饰键时不接：Ctrl+P / Cmd+P 是别人的快捷键。
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          const n = notes[focusIdx];
          if (n) {
            e.preventDefault();
            onTogglePin(n);
          }
          break;
        }
        case "m":
        case "M": {
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          const n = notes[focusIdx];
          const items = n ? folderMenu(n) : [];
          // 没地方可移（一个文件夹都没建）时不弹空菜单。
          if (n && ctxTrigger && items.length > 0) {
            e.preventDefault();
            // 键盘路径没有鼠标坐标，拿当前行的位置当锚点。
            const el = rowRefs.current[focusIdx];
            const r = el?.getBoundingClientRect();
            ctxTrigger(r ? r.left + 40 : 0, r ? r.bottom : 0, items);
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
    [
      focusIdx,
      moveTo,
      notes,
      onDelete,
      selectedIds,
      onClearSelection,
      onTogglePin,
      folderMenu,
      ctxTrigger,
      cols,
    ],
  );

  const folderName = useCallback(
    (id: string | null) => folders.find((f) => f.id === id)?.name ?? "未分类",
    [folders],
  );

  /**
   * 把键盘焦点索引挂到某一行。
   *
   * 🔴 悬停动作条上那三个按钮必须调它（2026-09-07 修）。它们是
   *   `tabIndex={-1}`，但**点击仍会拿到 DOM 焦点**，而之前不动 `focusIdx`。
   *   后果：点了第 10 行的置顶按钮再按 `P`，切的是 `focusIdx` 指向的那一行
   *   （可能是第 2 行）——而那两个快捷键正是为这三个按钮的可达性配的。
   *
   * ❗ 不调 `.focus()`：只同步索引，不把焦点从刚点的按钮上抢走。
   */
  const focusRow = useCallback((i: number) => setFocusIdx(i), []);


  return (
    // 键盘接在 `<ul>` 上而不是每行上：事件会冒泡上来，一份处理就够，
    // 而且分组头、加载更多哨兵那几个 `<li>` 不需要各自再接一遍。
    <ul
      className={layout === "grid" ? `${styles.list} ${styles.grid}` : styles.list}
      /* 列数用内联变量下发，避免为 2 列/3 列各写一个类。 */
      style={layout === "grid" ? ({ ["--kb-cols" as string]: String(cols) }) : undefined}
      onKeyDown={onListKeyDown}
    >
      {notes.map((note, i) => {
        // 行与卡片的 props 完全一致（同一份契约），只换渲染。
        const Item = layout === "grid" ? NoteCard : NoteRow;
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
            <Item
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
              folderMenu={folderMenu}
              ctxTrigger={ctxTrigger}
              onOpen={onOpen}
              onTogglePin={onTogglePin}
              onFocusRow={focusRow}
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

// `NOTE_DRAG_MIME` 已搬到 `@/lib/notes/dragMime`（2026-09-07）：
// 它的三个消费者里有 `NoteCard`，而本文件又导入 `NoteCard` ⇒ 循环依赖。

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
  folderMenu,
  ctxTrigger,
  onOpen,
  onTogglePin,
  onFocusRow,
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
  /** 仅文件夹列表（悬停条上的移动按钮用）。与 `buildMenu` 同源 */
  folderMenu: (note: Note) => MenuItem[];
  /** 右键菜单触发器。null = Provider 不在作用域里（那时不弹菜单） */
  ctxTrigger: ((x: number, y: number, items: MenuItem[]) => void) | null;
  onOpen: (note: Note) => void;
  onTogglePin: (note: Note) => void;
  /** 把键盘焦点索引挂到本行（动作条按下时调）。理由见列表层的 `focusRow`。 */
  onFocusRow: (index: number) => void;
  /* ❗ 没有 `onDelete`：行上那个删除按钮已收进「⋯」，
     删除现在只走两条路——`buildMenu` 里那项（右键与⋯共用）
     与列表层的 Delete 键。两者都在列表层，行组件不需要知道。 */
}) {
  // 字数条已随标题/摘要/元信息一起进了 `NoteItemBody`，那里自己算。
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
            它是卡片最强的视觉锚点，而笔记行本来一个图标都没有。
            有图的笔记装缩略图、没图的装来路图标——同记录模式的 `.cardImgThumb`。 */}
        <NoteRowIcon
          note={note}
          className={styles.rowIcon}
          thumbClassName={styles.rowIconThumb}
        />
        <span className={styles.rowBody}>
          <NoteItemBody
            note={note}
            keyword={keyword}
            showFolderColumn={showFolderColumn}
            folderName={folderName}
            onTagClick={onTagClick}
          />
        </span>
      </button>
      {/* ── 悬停动作条（设计稿 §3）──
          原来这里只有一个删除按钮，也就是说鼠标滑到行上时
          唯一能点的东西是个不可逆操作。现在三个全正向，删除进「⋯」。

          ❗ 没有「打开」按钮：设计稿列了一个，但它自己的表格里写的就是
            「同点行」——点整行已经是打开，再摆一个是纯冗余的 28px。
            而中栏只有 300px，每个按钮都得掘标题的宽度。

          ❗ 全部 `tabIndex={-1}`：否则 roving tabindex 白做了，
            Tab 一行停三次、一屏停一百多次。可达靠快捷键（P / M / Delete）
            与右键菜单，不靠 Tab。 */}
      {/* `onMouseDown` 而不是 `onClick`：要在按钮自己的 onClick 之**前**先把
          焦点索引对齐（否则 `⋯` 弹出的菜单里那些动作仍然指向旧行）。 */}
      <span className={styles.rowActs} onMouseDown={() => onFocusRow(index)}>
        <button
          type="button"
          className={`${styles.rowActBtn} ${note.pinned ? styles.rowActBtnOn : ""}`}
          title={note.pinned ? "取消置顶（P）" : "置顶（P）"}
          aria-label={note.pinned ? `取消置顶 ${note.title}` : `置顶 ${note.title}`}
          tabIndex={-1}
          onClick={() => onTogglePin(note)}
        >
          {note.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        {/* 移动与「⋯」都走 `ctxTrigger`（右键菜单那套现成机制），
            不另写弹层——也就不会出现「右键菜单改了、悬停条忘了改」。 */}
        <button
          type="button"
          className={styles.rowActBtn}
          title="移动到文件夹（M）"
          aria-label={`移动 ${note.title} 到文件夹`}
          tabIndex={-1}
          onClick={(e) => {
            const items = folderMenu(note);
            if (!ctxTrigger || items.length === 0) return;
            const r = e.currentTarget.getBoundingClientRect();
            ctxTrigger(r.left, r.bottom + 2, items);
          }}
        >
          <FolderInput size={14} />
        </button>
        <button
          type="button"
          className={styles.rowActBtn}
          title="更多"
          aria-label={`${note.title} 的更多操作`}
          tabIndex={-1}
          onClick={(e) => {
            if (!ctxTrigger) return;
            const r = e.currentTarget.getBoundingClientRect();
            ctxTrigger(r.left, r.bottom + 2, buildMenu(note));
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </span>
    </motion.li>
  );
}
