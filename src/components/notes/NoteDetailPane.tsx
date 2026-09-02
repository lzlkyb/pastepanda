/**
 * 笔记详情栏（B1 #1 宽屏三栏的第三栏）。≥800px 时取代弹窗。
 *
 * **它不是「把弹窗铺开」，而是改变了可能的动作集合**：弹窗的链条是
 * 「点一条 → 读 → 关掉 → 点下一条」，而笔记应用里最高频的动作是**扫着读**——
 * 上下过一遍，看到目标停下。每条都开关一次弹窗，这个动作根本不可能。
 *
 * 编辑器与保存逻辑与弹窗**完全共用**（`useNoteEditorState` + `NoteEditorPane`），
 * 只有壳不同。所以脏数据守卫 / 标题空校验 / 失败不关这些行为天然一致。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Copy, X, History } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { getContentTypeMeta } from "@/lib/contentTypes";
import { noteSetSummary, type Note } from "@/lib/api";
import { NoteEditorPane } from "./NoteEditorPane";
import { NoteHistoryView } from "./NoteHistoryView";
import { NoteAiActions } from "./NoteAiActions";
import { useNoteEditorState } from "./useNoteEditorState";
import styles from "./NoteDetailPane.module.css";

export function NoteDetailPane({
  note,
  onClose,
  onSaved,
}: {
  /**
   * 当前选中的笔记。
   *
   * ❗ 外层**必须给本组件带 `key={note.id}`**：CodeMirror 的初值只在挂载时读一次
   *   （见 NoteEditorPane 注释），不重建就会留着上一条的正文。
   */
  note: Note;
  /** 关掉详情（清选中）。脏数据确认由 hook 处理 */
  onClose: () => void;
  /** 保存成功后。**不关栏**——用户还在这条笔记上，只需刷列表 */
  onSaved: () => void;
}) {
  const ed = useNoteEditorState({
    target: {
      noteId: note.id,
      historyId: note.history_id,
      title: note.title,
      content: note.content,
      // 给「复制为 Markdown」的 frontmatter 用（弹窗那边的 draft 没有标签，写出来就没 tags 行）
      tags: note.tags,
    },
    onClose,
    onSaved,
  });

  const handleSave = useCallback(() => void ed.save(), [ed]);

  /** 历史视图（B1 #4）。切过去只是换掉编辑区，`ed` 不重建，所以草稿还在。 */
  const [showHistory, setShowHistory] = useState(false);

  /** 当前摘要（B1 轻量 AI）。本地先行显示，不等列表重拉。 */
  const [summary, setSummary] = useState<string | null>(note.summary);

  /** 第三栏进场：**只淡入、不做位移**。
   *
   * 本组件带 `key={note.id}`，每换一条笔记都整个重挂载，而 CodeMirror 在挂载时
   * 用 getBoundingClientRect 量坐标（见 NoteEditorPane）——祖先上正在跑 transform
   * 会让它量到错的位置，表现为光标/选区偏移。opacity 不改几何，所以安全。
   *
   * 也**不接 AnimatePresence**：那会让「扫着读」时每换一条都先等上一条退场完，
   * 而第三栏存在的全部理由就是扫读要快（见文件头注释）。位移留给空态与问答面板，
   * 那两个里面没有编辑器。
   */
  return (
    <motion.div
      className={styles.pane}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className={styles.head}>
        <input
          className={styles.titleInput}
          value={ed.title}
          onChange={(e) => ed.setTitle(e.target.value)}
          placeholder="笔记标题"
          aria-label="笔记标题"
        />
        {/* 关闭按钮：第三栏不是弹窗，但仍需要一个「我看完了」的出口，
            否则必须选另一条才能离开当前这条 */}
        <button
          type="button"
          className={styles.closeBtn}
          onClick={() => void ed.requestClose()}
          title="关闭"
          aria-label="关闭笔记"
        >
          <X size={13} />
        </button>
      </div>

      {/* AI 摘要（B1 轻量 AI）。只在真有时占位；点✕ 清掉，清成空串而不是 NULL——
          「从未生成」与「生成过又不要了」是两回事 */}
      {summary && (
        <div className={styles.summaryRow}>
          <span className={styles.summaryText}>✨ {summary}</span>
          <button
            type="button"
            className={styles.summaryClear}
            onClick={() => {
              void noteSetSummary(note.id, "").then((ok) => {
                if (!ok) return;
                setSummary(null);
                onSaved(); // 列表那行要退回正文截断，只改本地 state 它不知道
              });
            }}
            title="清掉摘要"
            aria-label="清掉摘要"
          >
            ✕
          </button>
        </div>
      )}

      {/* 来源行。与弹窗同口径：原卡片被删 → 置灰删除线，但笔记照旧存在 */}
      {note.history_id && (
        <div className={styles.sourceRow}>
          {ed.sourceItem ? (
            <>
              <span className={styles.sourceChip}>
                剪贴板 · {getContentTypeMeta(ed.sourceItem.content_type || ed.sourceItem.type).label} ·{" "}
                {relativeTime(ed.sourceItem.time)}
              </span>
              <button type="button" className={styles.sourceLink} onClick={ed.viewSource}>
                查看原卡片 <ExternalLink size={11} />
              </button>
            </>
          ) : (
            <span className={styles.sourceGone}>原卡片已删除</span>
          )}
        </div>
      )}

      {showHistory ? (
        <NoteHistoryView
          noteId={note.id}
          currentContent={ed.content}
          currentUpdatedAt={note.updated_at}
          isDirty={ed.isDirty}
          onBack={() => setShowHistory(false)}
          onRestored={(restored) => {
            ed.applyPersisted(restored.title, restored.content);
            setShowHistory(false);
            onSaved();
          }}
        />
      ) : (
        <NoteEditorPane
          /* 初值给当前草稿而不是 `note.content`：从历史视图返回时本组件会重新挂载，
             给 note.content 就把用户未保存的修改换成了库里的旧文。 */
          initialContent={ed.content}
          content={ed.content}
          isDark={ed.isDark}
          onChange={ed.setContent}
          onSave={handleSave}
        />
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => setShowHistory((v) => !v)}
          title="版本历史"
        >
          <History size={12} /> 历史
        </button>
        {/* AI 两个按钮。ai_enabled 关着时它自己返回 null，这里不用再判一次（规则 #16） */}
        <NoteAiActions
          noteId={note.id}
          title={ed.title}
          content={ed.content}
          btnClass={styles.ghostBtn}
          /* 两件都要做：本地 state 让✨行立刻出现（不等列表重拉），
             onSaved 让左侧列表那行的副标题换成摘要——只做前者的话，
             得切文件夹/搜索才看得到，看上去像没生效 */
          onSummary={(s) => {
            setSummary(s);
            onSaved();
          }}
          onTags={() => onSaved()}
        />
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => void ed.copyAsMarkdown()}
        >
          <Copy size={12} /> 复制为 Markdown
        </button>
        <div className={styles.footRight}>
          {/* 脏数据提示：第三栏没有弹窗那种「必须处理才能继续」的强制性，
              所以得给个看得见的未保存标记 */}
          {ed.isDirty && <span className={styles.dirtyDot}>未保存</span>}
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handleSave}
            disabled={ed.saving}
          >
            {ed.saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/** 未选任何笔记时的空态。
 *
 * **不把栏隐掉**：隐掉会让笔记列表宽度在选中前后跳一下。 */
export function NoteDetailEmpty() {
  /* 这里可以放心做位移：空态里没有编辑器，没人在挂载时量坐标。
     x 从 8 起是「从右侧滑进来」的方向，与它所在的第三栏同侧。 */
  return (
    <motion.div
      className={`${styles.pane} ${styles.empty}`}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className={styles.emptyIcon} aria-hidden="true">
        📝
      </div>
      <div className={styles.emptyText}>从左侧选一条笔记</div>
    </motion.div>
  );
}
