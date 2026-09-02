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
import { useCallback, useContext, useMemo, useState } from "react";
import { ChevronRight, FolderPlus, Inbox, Library } from "lucide-react";
import { CtxMenuCtx } from "@/components/ContextMenu";
import { buildFolderTree, type FolderFilter, type FolderNode, type NoteFolder } from "@/lib/api";
import { useFolderOps } from "./useFolderOps";
import { DailySection } from "./DailySection";
import { Trash2 } from "lucide-react";
import styles from "./FolderTree.module.css";

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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

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

  const renderNode = (node: FolderNode): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);

    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${selected === node.id ? styles.rowOn : ""}${
            landed === node.id ? ` ${styles.rowLanded}` : ""
          }`}
          style={{ paddingLeft: 10 + (node.depth - 1) * 10 }}
          onClick={() => onSelect(node.id)}
          onDoubleClick={() => void rename(node)}
          onContextMenu={(e) => {
            if (!ctxTrigger) return;
            e.preventDefault();
            ctxTrigger(e.clientX, e.clientY, buildMenu(node));
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(node.id);
            }
          }}
        >
          <button
            type="button"
            className={`${styles.caret} ${hasKids ? "" : styles.caretHidden}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
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
        >
          <FolderPlus size={12} />
        </button>
      </div>

      {/* 内置项：不可改名/删除/移动，画在分隔线上方 */}
      <div
        className={`${styles.row} ${selected === "all" ? styles.rowOn : ""}`}
        onClick={() => onSelect("all")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect("all")}
      >
        <Library size={12} className={styles.builtinIcon} />
        <span className={styles.name}>全部笔记</span>
        <span className={styles.count}>{totalCount}</span>
      </div>
      <div
        className={`${styles.row} ${selected === "unfiled" ? styles.rowOn : ""}${
          landed === "unfiled" ? ` ${styles.rowLanded}` : ""
        }`}
        onClick={() => onSelect("unfiled")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect("unfiled")}
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
        <button type="button" className={styles.emptyHint} onClick={() => void create(null)}>
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
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect("trash")}
      >
        <Trash2 size={12} className={styles.builtinIcon} />
        <span className={styles.name}>回收站</span>
        {trashCount > 0 && <span className={styles.count}>{trashCount}</span>}
      </div>
      </div>
    </div>
  );
}
