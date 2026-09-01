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
import styles from "./FolderTree.module.css";

export function FolderTree({
  folders,
  unfiledCount,
  totalCount,
  maxDepth,
  selected,
  onSelect,
  onChanged,
}: {
  folders: NoteFolder[];
  unfiledCount: number;
  totalCount: number;
  maxDepth: number;
  selected: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  /** 文件夹增删改后重拉（由 KnowledgeView 统一刷） */
  onChanged: () => void;
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
          className={`${styles.row} ${selected === node.id ? styles.rowOn : ""}`}
          style={{ paddingLeft: 11 + (node.depth - 1) * 13 }}
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
          <span className={styles.name}>{node.name}</span>
          <span className={styles.count}>{node.note_count}</span>
        </div>
        {hasKids && !isCollapsed && node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <div className={styles.tree}>
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
        <Library size={10} className={styles.builtinIcon} />
        <span className={styles.name}>全部笔记</span>
        <span className={styles.count}>{totalCount}</span>
      </div>
      <div
        className={`${styles.row} ${selected === "unfiled" ? styles.rowOn : ""}`}
        onClick={() => onSelect("unfiled")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect("unfiled")}
      >
        <Inbox size={10} className={styles.builtinIcon} />
        <span className={styles.name}>未分类</span>
        <span className={styles.count}>{unfiledCount}</span>
      </div>

      <div className={styles.sep} />

      {tree.length === 0 ? (
        // 零文件夹时给入口而不是禁用按钮：用户需要一个地方开始建结构
        <button type="button" className={styles.emptyHint} onClick={() => void create(null)}>
          还没有文件夹，点这里新建
        </button>
      ) : (
        tree.map(renderNode)
      )}
    </div>
  );
}
