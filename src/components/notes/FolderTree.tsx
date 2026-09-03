/**
 * 文件夹树侧栏（B1 #1）。设计稿 §2 / §6。
 *
 * 180px 推挤式，与记录模式的 `Sidebar` 同尺寸同手感（那边就是 `width: 0 → 180px`）。
 *
 * 两条不明显但重要的规则：
 * ① **内置项不是文件夹**：「全部笔记」/「未分类」不可改名删除，画在分隔线上方。
 *    照搬记录模式 Sidebar（它的内置项是「全部/收藏/未分组/截图」）。
 * ② **非法移动目标不出现在菜单里**，而不是选了才报错——同 A 阶段 file 卡片
 *    不显「转为笔记」的口径。但**后端仍是权威**（导入/MCP 不走 UI）。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderPlus, Inbox, Library } from "lucide-react";
import { CtxMenuCtx } from "@/components/ContextMenu";
import { NOTE_DRAG_MIME } from "./NoteList";
import { buildFolderTree, type FolderFilter, type FolderNode, type NoteFolder } from "@/lib/api";
import { useFolderOps } from "./useFolderOps";
import { DailySection } from "./DailySection";
import { Trash2 } from "lucide-react";
import styles from "./FolderTree.module.css";

/** 折叠状态的 localStorage 键。前缀跟项目其他键一致。 */
const COLLAPSE_KEY = "pastepanda_kb_folder_collapsed";

export function FolderTree({
  folders,
  unfiledCount,
  totalCount,
  trashCount,
  maxDepth,
  selected,
  onSelect,
  onChanged,
  landed,
  version,
  open,
  onDropNotes,
}: {
  folders: NoteFolder[];
  unfiledCount: number;
  totalCount: number;
  /** 回收站条数（W1）。0 时不显示数字，但**入口照旧在** */
  trashCount: number;
  maxDepth: number;
  selected: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  /** 文件夹增删改后重拉（由 KnowledgeView 统一刷） */
  onChanged: () => void;
  /**
   * 刚刚有笔记落进去的节点键（文件夹 id 或 `"unfiled"`）。`null` = 不闪。
   *
   * 移完一篇笔记后它就从当前列表消失了，这个高亮环就是「到哪去了」的回答。
   */
  landed: string | null;
  /** 数据版本号：递增就让「今日速记」区重拉它自己那几项（B2 #3） */
  version: number;
  /**
   * 拖拽落定（A3）。`folderId` 为 `null` = 未分类。
   *
   * ❗ 回收站**不接放**：删除得走确认框，一拖就删太危险。
   */
  onDropNotes?: (folderId: string | null, noteIds: string[]) => void;
  /**
   * 侧栏是否展开。
   *
   * ❗ 本组件**常挂载**，关闭时靠 CSS 把栏宽收到 0，而不是在外层写
   *   `{sidebarOpen && <FolderTree/>}`——后者是硬挂硬消，做不了宽度动画。
   *   记录模式的 `Sidebar` 也是常挂载的。
   *
   * 常挂载的代价只有一个 COUNT：`DailySection` 已经把贵的查询
   * （打点日期 / 最早日期）门控在展开态，只有总数那一个 COUNT 常拉。
   */
  open: boolean;
}) {
  /**
   * 右键菜单触发器。**复用项目现有的 ContextMenu 体系**（已处理边界翻转 /
   * 键盘导航 / Esc / 点外关闭），不自己搭。
   *
   * ❗ Provider 原本只在 `CardList` 里，而 CardList 只在记录模式渲染——
   *   所以 KnowledgeView 自带了一个 `<ContextMenu>`。拿不到就降级为无右键菜单
   *   （双击改名仍可用），而不是报错。
   */
  const ctxTrigger = useContext(CtxMenuCtx);

  /**
   * 折叠状态**持久化**。不持久化的话，每次切回知识模式都是全展开，
   * 而折叠本身就是为了把暂时用不上的子树收起来——一刷新就回来等于没做。
   *
   * 落 localStorage 而不是后端配置：它是纯展示层的临时状态，不值得为它动 schema。
   * 项目里 `AiQuickActions` 的拖拽顺序用的是同一套做法。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      // 解不出来就当全展开。一个坏掉的展示层偏好不能让侧栏渲染不出来。
      return new Set<string>();
    }
  });

  // ❗ 写入放在 effect 里而不是 `setCollapsed` 的 updater 里：updater 可能在
  //   render 阶段被调（StrictMode 会双调），而 localStorage 写入是副作用。
  //   这个坑项目里踩过一次（App.tsx 里 `aiAwarenessActive` 那条注释）。
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    } catch {
      // 写不进去（隐私模式 / 配额满）不影响功能，下次打开全展开而已。
    }
  }, [collapsed]);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  /** 当前悬停在哪个放置目标上（A3）。`"unfiled"` 或文件夹 id。 */
  const [dropOn, setDropOn] = useState<string | null>(null);

  /**
   * 把一行变成放置目标。返回要展开到 `<div>` 上的一组 props。
   *
   * ❗ `onDragOver` 里必须 `preventDefault()`，否则浏览器根本不会触发 `drop`
   *   ——这是 HTML 拖放 API 最常见的一个坑（默认行为是「不允许放」）。
   * ❗ 只认自定义 MIME：不然从桌面拖一个文件进来也会高亮，而我们处理不了它。
   */
  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!onDropNotes || !e.dataTransfer.types.includes(NOTE_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move" as const;
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      setDropOn(null);
      if (!onDropNotes) return;
      const raw = e.dataTransfer.getData(NOTE_DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      try {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids) && ids.length > 0) onDropNotes(folderId, ids);
      } catch {
        // 载荷坏了就当没拖。它只可能来自本应用，坏了也无从补救。
      }
    },
  });

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 增删改与右键菜单构造已收进 useFolderOps（合在本文件会超规则 #7 的 300 行）
  const { create, rename, buildMenu } = useFolderOps({
    folders,
    maxDepth,
    selected,
    onSelect,
    onChanged,
  });

  /**
   * 内置项（全部 / 未分类 / 回收站）的键盘响应。
   *
   * ❗ 原先只认 Enter，而同一棵树里的文件夹节点认的是 Enter + Space。
   *   `role="button"` 的原生语义本来就是两个都响应，而「同一类控件两种口径」
   *   是最难被发现的那类不一致：用户按空格没反应，只会以为自己按错了。
   */
  const builtinKey = useCallback(
    (f: FolderFilter) => (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(f);
      }
    },
    [onSelect],
  );

  const renderNode = (node: FolderNode): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);

    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${selected === node.id ? styles.rowOn : ""}${
            landed === node.id ? ` ${styles.rowLanded}` : ""
          }${dropOn === node.id ? ` ${styles.rowDrop}` : ""}`}
          style={{ paddingLeft: 10 + (node.depth - 1) * 10 }}
          {...dropProps(node.id, node.id)}
          onClick={() => onSelect(node.id)}
          onDoubleClick={() => void rename(node)}
          onContextMenu={(e) => {
            if (!ctxTrigger) return;
            e.preventDefault();
            ctxTrigger(e.clientX, e.clientY, buildMenu(node));
          }}
          role="button"
          /* ❗ 收起时必须退出 Tab 序。本组件是**常挂载**的（为了做宽度动画），
             而 CSS 只把栏宽收到 0 + `opacity: 0`——两者都**不**把元素移出焦点序。
             不处理的后果：用户按 Tab，焦点进了一个宽 0 的栏，屏幕上毫无反应，
             要连按十几次才出得来。记录模式的 `Sidebar` 早就是这么写的（七处），
             这里是把它抄齐（规则 #11.1）。 */
          tabIndex={open ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(node.id);
              return;
            }
            // ←/→ 折叠展开。标准 tree 的键位，而且比把三角做成可聚焦元素好：
            // 后者会让 Tab 在每个文件夹上多停一次。
            if (!hasKids) return;
            if (e.key === "ArrowRight" && isCollapsed) {
              e.preventDefault();
              toggle(node.id);
            } else if (e.key === "ArrowLeft" && !isCollapsed) {
              e.preventDefault();
              toggle(node.id);
            }
          }}
          /* 双击改名原先没任何可发现性——不看源码根本不知道它存在。
             挂在行上而不是 `.name` 上：`.name` 那个 `title` 是名字全文（截断时必需），
             两个合一个的话名字长的时候反而读不到全文了。 */
          title="双击改名，右键更多操作"
        >
          <button
            type="button"
            className={`${styles.caret} ${hasKids ? "" : styles.caretHidden}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
            /* 故意不进 Tab 序：键盘用 ←/→ 折叠（见上面行的 onKeyDown）。 */
            aria-label={isCollapsed ? "展开" : "折叠"}
            tabIndex={-1}
          >
            <ChevronRight size={9} className={isCollapsed ? "" : styles.caretOpen} />
          </button>
          {/* ❗ `title` 是必需而不是锥上添花：`.name` 只有 `text-overflow: ellipsis`，
              名字一截断就**根本读不到**。行高字号对齐记录模式后名字区又窄了
              （第 3 层约 5.5 个中文字，第 4 层约 4.7 个），这从「不够好」变成了「必需」。
              ❗ 深度上限抬到 4 就是以它为前提的（见 `MAX_FOLDER_DEPTH` 的注释），
                所以这个 `title` 不能再去掉。 */}
          <span className={styles.name} title={node.name}>
            {node.name}
          </span>
          <span className={styles.count}>{node.note_count}</span>
        </div>
        {hasKids && !isCollapsed && node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <div className={`${styles.tree} ${open ? styles.treeOpen : ""}`}>
      {/* 内层滚动层。外层只管宽度动画与裁切（见 CSS 里为何必须分两层）。 */}
      <div className={styles.list}>
      <div className={styles.head}>
        <span>文件夹</span>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => void create(null)}
          title="新建文件夹"
          aria-label="新建文件夹"
          tabIndex={open ? 0 : -1}
        >
          <FolderPlus size={12} />
        </button>
      </div>

      {/* 内置项：不可改名/删除/移动，画在分隔线上方 */}
      <div
        className={`${styles.row} ${selected === "all" ? styles.rowOn : ""}`}
        onClick={() => onSelect("all")}
        role="button"
        tabIndex={open ? 0 : -1}
        onKeyDown={builtinKey("all")}
      >
        <Library size={12} className={styles.builtinIcon} />
        <span className={styles.name}>全部笔记</span>
        <span className={styles.count}>{totalCount}</span>
      </div>
      <div
        className={`${styles.row} ${selected === "unfiled" ? styles.rowOn : ""}${
          landed === "unfiled" ? ` ${styles.rowLanded}` : ""
        }${dropOn === "unfiled" ? ` ${styles.rowDrop}` : ""}`}
        {...dropProps("unfiled", null)}
        onClick={() => onSelect("unfiled")}
        role="button"
        tabIndex={open ? 0 : -1}
        onKeyDown={builtinKey("unfiled")}
      >
        <Inbox size={12} className={styles.builtinIcon} />
        <span className={styles.name}>未分类</span>
        <span className={styles.count}>{unfiledCount}</span>
      </div>

      {/* 今日速记（B2 #3）。也是内置项——不能改名/删除/移动，
          所以与上面两项同在分隔线上方。选中时它会就地展开月历 */}
      <DailySection selected={selected} onSelect={onSelect} version={version} />

      <div className={styles.sep} />

      {tree.length === 0 ? (
        // 零文件夹时给入口而不是禁用按钮：用户需要一个地方开始建结构
        <button
          type="button"
          className={styles.emptyHint}
          onClick={() => void create(null)}
          tabIndex={open ? 0 : -1}
        >
          还没有文件夹，点这里新建
        </button>
      ) : (
        tree.map(renderNode)
      )}

      {/* 回收站（W1）。**放在最底部、与文件夹树再隔一条线**，不跟上面三个
          内置项平列：它里面的东西不参与搜索、不算进总数、不能编辑，
          根本不是一个「看笔记的视图」。用位置把这件事说清楚，不需要额外文案。

          ❗ 空的时候也照显（只是不写数字）。隐藏会让用户在真需要它的那一刻
          （刚删错）找不到——而那正是它唯一被需要的时刻。 */}
      <div className={styles.sep} />
      <div
        className={`${styles.row} ${styles.rowTrash} ${selected === "trash" ? styles.rowOn : ""}`}
        onClick={() => onSelect("trash")}
        role="button"
        tabIndex={open ? 0 : -1}
        onKeyDown={builtinKey("trash")}
      >
        <Trash2 size={12} className={styles.builtinIcon} />
        <span className={styles.name}>回收站</span>
        {trashCount > 0 && <span className={styles.count}>{trashCount}</span>}
      </div>
      </div>
    </div>
  );
}
