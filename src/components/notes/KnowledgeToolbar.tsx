/**
 * KnowledgeToolbar.tsx —— 知识模式中栏顶部：面包屑 + 新建 + 搜索/提问。
 *
 * 从 `KnowledgeView` 里抽出来的：那边已经恰好 300 行（规则 #7 的上限），
 * 再加一个「＋」就超了。此处正好是一块完整的展示层，不担任何数据职责。
 *
 * ❗ 溢出菜单的 `trigger` 必须在**本组件**拿（而不是 `KnowledgeView`）：
 *   `KnowledgeView` 自己渲染 `<ContextMenu>`，所以它在 `CtxMenuCtx.Provider`
 *   的**外面**，`useContext` 在那里拿不到东西。菜单项的数据由它算好传下来。
 *   （同 `BatchBar` 当时只能自造下拉的同类问题。）
 *
 * 样式沿用 `KnowledgeView.module.css`：这几个类本来就是给它写的，
 * 再开一个 css module 只会让同一行的样式散在两个文件里。
 */
import { useContext, useRef } from "react";
import { Search, Plus, Sparkles, X, MoreHorizontal, Columns3 } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { useAutoGrow } from "@/hooks/useAutoGrow";
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
  moreItems,
  showWideBtn,
  onWide,
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
  /**
   * 「⋯」溢出菜单的项（A-61 ③）。不传就不渲染那个按钮。
   * 项里的回调指向 `KnowledgeView` 的 handler，本组件只负责把它们弹出来。
   */
  moreItems?: MenuItem[];
  /**
   * 显示「宽屏」按钮（A-61 ④）。**只在 &lt;800px 时为 true**：
   * ≥800px 已经是三栏，按钮无事可做，也因此不会与三栏共存、不挤面包屑行。
   */
  showWideBtn?: boolean;
  onWide?: () => void;
}) {
  const ctxTrigger = useContext(CtxMenuCtx);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 问题框随内容长高（A-61 ②）。`enabled` 必须传：本框只在问模式渲染，
   *  从搜切回问时它是新挂载的，而那一刻 `question` 可能没变。 */
  const askRef = useAutoGrow(question, { enabled: mode === "ask" });

  /** 弹溢出菜单。坐标取按钮左下角，菜单从按钮下方展开（同普通下拉的位置感）。 */
  const openMore = () => {
    if (!ctxTrigger || !moreItems) return;
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    ctxTrigger(r.left, r.bottom + 2, moreItems);
  };

  return (
    <>
      {/* 面包屑：**侧栏收起时也显示**，否则列表变成无上下文的子集。

          这里原本还有一个展开文件夹的汉堡按钮，已移除：
          侧栏开关统一到顶栏的 ☰，不再按页面换位置。 */}
      <div className={styles.crumb}>
        <b>{folderName}</b>
        <span>· {total} 条</span>

        {/* 右侧动作组。`margin-left:auto` 在本容器上而不在单个按钮上：
            按钮个数会变（宽屏按钮只在窄屏出），放单个按钮上就得跟着改。 */}
        <span className={styles.crumbActions}>
          {/* 宽屏布局（A-61 ④）。很多用户不会主动拖窗口，根本不知道有三栏形态。 */}
          {showWideBtn && onWide && (
            <button
              type="button"
              className={styles.wideBtn}
              onClick={onWide}
              title="加宽窗口并展开侧栏，可并排查看笔记（不改你的数据）"
              aria-label="切到宽屏布局"
            >
              <Columns3 size={12} />
              <span>宽屏</span>
            </button>
          )}

          <button
            type="button"
            className={styles.newBtn}
            onClick={onNew}
            title={newHint}
            aria-label="新建空白笔记"
          >
            <Plus size={13} />
          </button>

          {moreItems && (
            <button
              type="button"
              ref={moreBtnRef}
              className={styles.newBtn}
              onClick={openMore}
              title="导入 / 导出 / 回收站"
              aria-label="更多"
            >
              <MoreHorizontal size={13} />
            </button>
          )}
        </span>
      </div>

      <div className={styles.searchRow}>
        {/* 搜索盒子。结构照记录模式 `TopBar .searchBox`：**盒子提供边框与底色，
            里面装的是裸 input**。原先是反的（带样式的 input + 绝对定位盖上去的图标），
            那是两边看上去不一样的结构原因。

            聚焦光环靠 CSS 的 `:focus-within`，不像记录模式那样拉一个 React state
            推 `.focused` 类——裸 input 的 `:focus` 给不了父盒子上样式。

            ❗ 问模式多一个 `.searchBoxTall`：输入框会长高，盒子得从固定 38px 改成自适应，
              且里面的控件靠上对齐（不然它们会跟着四行高的框居中飘到中间）。 */}
        <div
          className={
            mode === "ask" ? `${styles.searchBox} ${styles.searchBoxTall}` : styles.searchBox
          }
        >
          {/* 搜/问 切换（B2 #10）。在**框内**，它同时当「这是个搜索/提问框」的标识，
              所以框里不再同时摆一个放大镜（信息重复，而它占的是 34px 左内边距）。 */}
          {qaEnabled ? (
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
          ) : mode === "ask" ? (
            /* AI 关着时没有切换器，图标必须补回来——不然这个框就没任何
               「这是搜索」的提示了。14px 同记录模式顶栏。
               仍然分 ask / search 两个图标：mode 是持久的，用户在 ask 下去关了 AI 开关
               就会落到这条分支，占着问答的占位文字却配个放大镜是对不上的。 */
            <Sparkles size={14} className={styles.searchIcon} />
          ) : (
            <Search size={14} className={styles.searchIcon} />
          )}

          {mode === "ask" ? (
            /* ❗ `textarea` 而不是 `input`（A-61 ②）：问题天然比搜索词长得多，
                 单行框里只能看到开头十几个字。搜模式不改：边打边搜的关键词不会长，
                 换成 textarea 只会让它在两种高度间跳。 */
            <textarea
              ref={askRef}
              className={`${styles.searchInput} ${styles.askArea}`}
              value={question}
              rows={1}
              onChange={(e) => onQuestion(e.target.value)}
              onKeyDown={(e) => {
                // ❗ `isComposing` 必须守：中文输入法选字的 Enter 不能当提交。
                //   Shift+Enter 换行（所以不能 preventDefault）。
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  // 阻止默认行为：不拦的话提问同时还会往框里插一个换行。
                  e.preventDefault();
                  onAsk();
                } else if (e.key === "Escape" && question) {
                  // Esc 清空但**不失焦**：按 Esc 的意图是「重新问一个」，
                  // 不是「离开输入框」。搜索那边同理。
                  e.preventDefault();
                  onQuestion("");
                }
              }}
              placeholder="问知识库…（回车提问，Shift+回车换行）"
              aria-label="问知识库"
            />
          ) : (
            <input
              className={styles.searchInput}
              value={keyword}
              onChange={(e) => onKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && keyword) {
                  e.preventDefault();
                  onKeyword("");
                }
              }}
              placeholder="搜笔记（中文 / 拼音首字母）"
              aria-label="搜笔记"
            />
          )}

          {/* 清空✕。只在有内容时渲染——改之前想回到全部列表得手动全选删除。
              `tabIndex={-1}`：它旁边就是输入框，而输入框里 Esc 已经能清空，
              再占一个 Tab 停靠点不值。 */}
          {(mode === "ask" ? question : keyword) && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => (mode === "ask" ? onQuestion("") : onKeyword(""))}
              title="清空（Esc）"
              aria-label="清空"
              tabIndex={-1}
            >
              <X size={11} />
            </button>
          )}

          {/* 提交按钮只在问模式出。搜模式不需要：它是边打边搜的，没有「提交」这个动作。
              改之前只能回车，而一个只能用键盘触发的动作在界面上等于不存在。 */}
          {mode === "ask" && (
            <button
              type="button"
              className={styles.askBtn}
              onClick={onAsk}
              disabled={!question.trim()}
              title="提问（回车）"
            >
              问
            </button>
          )}
        </div>
        {controls}
      </div>

      {chips}
    </>
  );
}
