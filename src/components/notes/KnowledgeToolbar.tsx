/**
 * KnowledgeToolbar.tsx —— 知识模式中栏顶部：面包屑 + 新建 + 搜索。
 *
 * 从 `KnowledgeView` 里抽出来的：那边已经恰好 300 行（规则 #7 的上限），
 * 再加一个「＋」就超了。此处正好是一块完整的展示层，不担任何数据职责。
 *
 * 样式沿用 `KnowledgeView.module.css`：这几个类本来就是给它写的，
 * 再开一个 css module 只会让同一行的样式散在两个文件里。
 */
import { Search, Plus } from "lucide-react";
import styles from "../KnowledgeView.module.css";

export function KnowledgeToolbar({
  folderName,
  total,
  keyword,
  onKeyword,
  onNew,
  newHint,
  controls,
  chips,
}: {
  folderName: string;
  total: number;
  keyword: string;
  onKeyword: (v: string) => void;
  /** 新建空白笔记（#13）。落入哪个文件夹由调用方决定 */
  onNew: () => void;
  /** 新建按钮的悬停提示。由调用方给：选「全部」时落点并不是面包屑上那个名字 */
  newHint: string;
  /** 字段视图的三个图标（B2 #9）。塞在**搜索行内**，不另开一行——
   *  下面那句注释就是为这个写的：480px 宽的窗口里多一行就少两条笔记 */
  controls?: React.ReactNode;
  /** 已生效选项的 chips 行。**默认态它自己返回 null**，所以不占行高 */
  chips?: React.ReactNode;
}) {
  return (
    <>
      {/* 面包屑：**侧栏收起时也显示**，否则列表变成无上下文的子集。

          这里原本还有一个展开文件夹的汉堡按钮，已移除：
          侧栏开关统一到顶栏的 ☰，不再按页面换位置。 */}
      <div className={styles.crumb}>
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
        {controls}
      </div>

      {chips}
    </>
  );
}
