/**
 * 转为笔记 / 编辑笔记弹窗（知识库 A 阶段 · 规划 §8.1 3️⃣，设计稿 design/kb-a-note-dialog.html §2）。
 *
 * 由 dialogStore 的 `noteDraft` 驱动，`noteId` 是否为空区分新建 / 编辑。
 * 挂在 App.tsx 顶层而不是 CardList 里：**知识模式下 CardList 根本不渲染**，
 * 挂进去的话从笔记列表点开笔记会得到一个永远不出现的弹窗。
 *
 * 🔴 红线：全程无 AI。标题与正文只进本机 SQLite 与本机 FTS。
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Copy, History } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { relativeTime } from "@/lib/utils";
import { getContentTypeMeta } from "@/lib/contentTypes";
import { NoteEditorPane } from "./NoteEditorPane";
import { NoteHistoryView } from "./NoteHistoryView";
import { useNoteEditorState } from "./useNoteEditorState";
import styles from "./NoteDialog.module.css";

export function NoteDialog() {
  const draft = useDialogStore((s) => s.noteDraft);
  const anim = useDialogAnim();

  return (
    <AnimatePresence>
      {draft && (
        // key 带上 noteId/historyId：换一条笔记就重建内部。
        // 必需——CodeMirror 的初值只在挂载时读一次（见 NoteEditorPane 注释），
        // 不重建就会留着上一条的正文。
        <NoteDialogInner key={draft.noteId ?? `new:${draft.historyId ?? "blank"}`} anim={anim} />
      )}
    </AnimatePresence>
  );
}

function NoteDialogInner({ anim }: { anim: ReturnType<typeof useDialogAnim> }) {
  // 非空断言：外层已经判过 draft 存在才渲染本组件
  const draft = useDialogStore((s) => s.noteDraft)!;
  const closeNote = useDialogStore((s) => s.closeNote);
  // 主题 / 跳转原卡片 / toast 全已进 `useNoteEditorState`，本组件不再直接读 store。

  // 状态与保存逻辑全在 hook 里，与宽屏第三栏（NoteDetailPane）共用。
  // 不共用就是两份保存逻辑，而两份中必有一份会漏个分支。
  const ed = useNoteEditorState({
    target: draft,
    onClose: closeNote,
    // 弹窗的语义：保存成功就关窗（第三栏的语义是留在原地）
    onSaved: closeNote,
  });
  const handleSave = useCallback(() => void ed.save(), [ed]);
  const handleClose = ed.requestClose;

  /** 历史视图（B1 #4）。切过去只是换掉正文区，`ed` 不重建，所以草稿还在。 */
  const [showHistory, setShowHistory] = useState(false);

  // Esc 自己接（与 ItemEditorDialog 同口径）：App.tsx 的全局分层对 noteDraft 只做
  // `return`、不代关，否则脏数据确认根本没机会弹。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void handleClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleClose]);

  return (
    <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={() => void handleClose()}>
      <FocusTrap>
        <motion.div
          {...anim.panel}
          className="dialog-box w520 dialog-solid"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            {/* 三种形态：改已有 / 从卡片转 / 空白新建（#13）。
                空白新建也叫「转为笔记」会让人找一张不存在的源卡片 */}
            <h2 className="dialog-title">
              📝 {draft.noteId ? "编辑笔记" : draft.historyId ? "转为笔记" : "新建笔记"}
            </h2>
            <button className="dialog-close" onClick={() => void handleClose()} aria-label="关闭">
              <X size={14} />
            </button>
          </div>

          <div className={styles.body}>
            <input
              className={styles.titleInput}
              value={ed.title}
              onChange={(e) => ed.setTitle(e.target.value)}
              placeholder="笔记标题"
              aria-label="笔记标题"
            />

            {/* 来源行。原卡片被删 → 置灰不可点，但笔记本身照旧存在（无级联删除） */}
            {draft.historyId && (
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

            {showHistory && draft.noteId ? (
              <NoteHistoryView
                noteId={draft.noteId}
                currentContent={ed.content}
                /* 弹窗的 draft 里没有 updated_at（它只带编辑所需的四个字段）。
                   不为了一行时间把它加进 store：少一个会与库里不同步的副本。 */
                currentUpdatedAt={undefined}
                isDirty={ed.isDirty}
                onBack={() => setShowHistory(false)}
                onRestored={(restored) => {
                  ed.applyPersisted(restored.title, restored.content);
                  setShowHistory(false);
                }}
              />
            ) : (
              <NoteEditorPane
                /* 初值给当前草稿而不是 `draft.content`：从历史视图返回时本组件会重新挂载，
                   给 draft.content 就把用户未保存的修改换成了打开时的旧文。 */
                initialContent={ed.content}
                content={ed.content}
                isDark={ed.isDark}
                onChange={ed.setContent}
                onSave={handleSave}
              />
            )}
          </div>

          <div className={styles.footer}>
            {/* 历史入口只给已存在的笔记：新建 / 刚转的还没 id，也不可能有历史 */}
            {draft.noteId && (
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setShowHistory((v) => !v)}
                title="版本历史"
              >
                <History size={12} /> 历史
              </button>
            )}
            <button type="button" className={styles.ghostBtn} onClick={() => void ed.copyAsMarkdown()}>
              <Copy size={12} /> 复制为 Markdown
            </button>
            <div className={styles.footerRight}>
              <button type="button" className={styles.ghostBtn} onClick={() => void handleClose()}>
                取消
              </button>
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
      </FocusTrap>
    </motion.div>
  );
}
