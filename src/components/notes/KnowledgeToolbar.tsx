/**
 * KnowledgeToolbar.tsx —— 知识模式中栏顶部：面包屑 + 新建 + 搜索。
 *
 * 从 `KnowledgeView` 里抽出来的：那边已经恰好 300 行（规则 #7 的上限），
 * 再加一个「＋」就超了。此处正好是一块完整的展示层，不担任何数据职责。
 *
 * 样式沿用 `KnowledgeView.module.css`：这几个类本来就是给它写的，
 * 再开一个 css module 只会让同一行的样式散在两个文件里。
 */
import { Search, Plus, Sparkles } from "lucide-react";
import styles from "../KnowledgeView.module.css";

/** 搜索框的两种用法（B2 #10） */
export type KnowledgeMode = "search" | "ask";

export function KnowledgeToolbar({
  folderName,
  total,
  keyword,
  onKeyword,
  onNew,
  newHint,
  controls,
  chips,
  qaEnabled,
  mode,
  onMode,
  question,
  onQuestion,
  onAsk,
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
  /**
   * 问答可用（AI 开关开着）。关着时切换器**整个不渲染**，不是置灰
   * （规则 #16：未启用 = 零可见零请求零费用）。此时这一行与做这个功能之前一模一样。
   */
  qaEnabled: boolean;
  mode: KnowledgeMode;
  onMode: (m: KnowledgeMode) => void;
  /**
   * 问题文本。**与 `keyword` 分开存**——共用一个值的话，切回搜模式会拿整句问题
   * 去搜索（而那是 AND 语义，必然零结果），看起来就是搜索坏了。
   */
  question: string;
  onQuestion: (v: string) => void;
  /** 回车提问 */
  onAsk: () => void;
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
        {/* 搜/问 切换（B2 #10）。AI 关着就不渲染，这一行退回原样 */}
        {qaEnabled && (
          <div className={styles.modeSeg} role="group" aria-label="搜索或提问">
            <button
              type="button"
              className={mode === "search" ? styles.modeOn : styles.modeBtn}
              onClick={() => onMode("search")}
              title="搜笔记"
            >
              搜
            </button>
            <button
              type="button"
              className={mode === "ask" ? styles.modeOn : styles.modeBtn}
              onClick={() => onMode("ask")}
              title="问知识库（问题与命中的笔记片段会发到云端）"
            >
              问
            </button>
          </div>
        )}

        {/* 图标的绝对定位基准得是输入框而不是整行，否则加了切换器之后它会盖在切换器上 */}
        <div className={styles.inputWrap}>
          {mode === "ask" ? (
            <Sparkles size={13} className={styles.searchIcon} />
          ) : (
            <Search size={13} className={styles.searchIcon} />
          )}
          {mode === "ask" ? (
            <input
              className={styles.searchInput}
              value={question}
              onChange={(e) => onQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) onAsk();
              }}
              placeholder="问知识库…（回车提问）"
              aria-label="问知识库"
            />
          ) : (
            <input
              className={styles.searchInput}
              value={keyword}
              onChange={(e) => onKeyword(e.target.value)}
              placeholder="搜笔记（中文 / 拼音首字母）"
              aria-label="搜笔记"
            />
          )}
        </div>
        {controls}
      </div>

      {chips}
    </>
  );
}
