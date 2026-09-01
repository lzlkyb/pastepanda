/**
 * KnowledgeToolbar.tsx —— 知识模式中栏顶部：面包屑 + 新建 + 搜索。
 *
 * 从 `KnowledgeView` 里抽出来的：那边已经恰好 300 行（规则 #7 的上限），
 * 再加一个「＋」就超了。此处正好是一块完整的展示层，不担任何数据职责。
 *
 * 样式沿用 `KnowledgeView.module.css`：这几个类本来就是给它写的，
 * 再开一个 css module 只会让同一行的样式散在两个文件里。
 */
import { Search, PanelLeft, Plus } from "lucide-react";
import styles from "../KnowledgeView.module.css";

export function KnowledgeToolbar({
  folderName,
  total,
  showBurger,
  sidebarOpen,
  onToggleSidebar,
  keyword,
  onKeyword,
  onNew,
  newHint,
}: {
  folderName: string;
  total: number;
  /** 侧栏常驻时不需要汉堡按钮 */
  showBurger: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  keyword: string;
  onKeyword: (v: string) => void;
  /** 新建空白笔记（#13）。落入哪个文件夹由调用方决定 */
  onNew: () => void;
  /** 新建按钮的悬停提示。由调用方给：选「全部」时落点并不是面包屑上那个名字 */
  newHint: string;
}) {
  return (
    <>
      {/* 面包屑：**侧栏收起时也显示**，否则列表变成无上下文的子集 */}
      <div className={styles.crumb}>
        {showBurger && (
          <button
            type="button"
            className={styles.burger}
            onClick={onToggleSidebar}
            title={sidebarOpen ? "收起文件夹" : "展开文件夹"}
            aria-label="切换文件夹侧栏"
          >
            <PanelLeft size={12} />
          </button>
        )}
        <b>{folderName}</b>
        <span>· {total} 条</span>

        {/* 新建空白笔记。靠右（.newBtn 带 margin-left:auto），不另开工具栏：
            480px 宽的窗口里多一行就少两条笔记 */}
        <button
          type="button"
          className={styles.newBtn}
          onClick={onNew}
          title={newHint}
          aria-label="新建空白笔记"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className={styles.searchRow}>
        <Search size={13} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          placeholder="搜笔记（中文 / 拼音首字母）"
          aria-label="搜笔记"
        />
      </div>
    </>
  );
}
