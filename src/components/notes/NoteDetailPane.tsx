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
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Copy, X, History, MoreHorizontal, EyeOff } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { relativeTime } from "@/lib/utils";
import { getContentTypeMeta } from "@/lib/contentTypes";
import { noteSetSummary, type Note } from "@/lib/api";
import { NoteEditorPane } from "./NoteEditorPane";
import { NoteHistoryView } from "./NoteHistoryView";
import { NoteConflictView } from "./NoteConflictView";
import { NoteConflictBanner } from "./NoteConflictBanner";
import { isConflictCopy } from "@/lib/kbConflict";
import { NoteBacklinks } from "./NoteBacklinks";
import { NoteAiActions } from "./NoteAiActions";
import { useNoteEditorState } from "./useNoteEditorState";
import { NoteViewModeSwitch, useNoteViewMode } from "./NoteViewModeSwitch";
import styles from "./NoteDetailPane.module.css";

/**
 * 分屏可用的最小栏宽。
 *
 * 第三栏宽 = 窗口宽 − 侧栏 180 − 中栏 300，所以 800px 断点上它只有 ~315px，
 * 分屏后每边 ~150px——放不下一行中文。460 是 `.editPane` 自己那条
 * 行长限制注释里的数（「34em 在 13.5px 下约 460px」）乘以两边。
 */
const SPLIT_MIN_WIDTH = 620;

export function NoteDetailPane({
  note,
  onClose,
  onSaved,
  notInList,
  onRegister,
  onOpenNote,
  buildMenu,
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
  /**
   * 按 id 打开另一篇（反链面板点击用）。
   *
   * ❗ 不在本组件里自己切：切笔记要过**脏数据守卫**，而那个守卫
   * （`handleOpen`）住在宿主那边——本组件只是通过 `onRegister` 把它报上去。
   *
   * 🔴 返回 `Promise<boolean>` 而不是 `void`（2026-09-07 修）：
   *   旧类型是 `void`，于是「守卫拦下了」这件事**在类型上就无处可接**。
   *   后果看 `onResolved` 那里的注释。
   */
  onOpenNote?: (id: string) => Promise<boolean>;
  /** 保存成功后。**不关栏**——用户还在这条笔记上，只需刷列表 */
  onSaved: () => void;
  /**
   * 这条笔记不在旁边列表的当前结果里（搜了个词 / 切了文件夹）。
   *
   * 此时**故意不清空选中**：那是用户正在写的东西，清掉就是又一条静默丢失。
   * 只把「它和旁边列表对不上」这件事说出来。
   */
  notInList?: boolean;
  /**
   * 把守卫与当前草稿交给宿主。`null` = 本栏要卸载了。
   *
   * ❗ 必须往上交：草稿住在本组件里，而「要不要换掉这一栏」是 `KnowledgeView`
   *   在决定——不交的话它无从得知这里有没有未保存的东西。
   */
  onRegister?: (
    v: { guard: () => Promise<boolean>; dirty: boolean; title: string; content: string } | null,
  ) => void;
  /**
   * 置顶 / 移动 / 删除菜单（头部那个 `⋯`）。来自 `useNoteMenu`，
   * 与中栏行右键、悬停条的 `⋯` **是同一份**。
   *
   * ❗ 可选：不传就不画那个按钮。给它默认值比强制传好——
   *   菜单靠 `CtxMenuCtx`，而 Provider 不在作用域里时本来就弹不出来。
   */
  buildMenu?: (note: Note) => MenuItem[];
}) {
  /** 弹菜单的触发器。`null` = Provider 不在作用域里（那时不画 `⋯`）。
      `<ContextMenu>` 包在 `KnowledgeView` 最外层，第三栏在它里面，所以拿得到。 */
  const ctxTrigger = useContext(CtxMenuCtx);
  const moreRef = useRef<HTMLButtonElement | null>(null);
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

  /**
   * 形态（仅编辑 / 分屏 / 仅预览）。第三栏打开的都是**已有笔记**，
   * 所以 `isNew` 恒为 false——新建走的是弹窗那条路（设计稿 §11）。
   */
  const [viewMode, setViewMode] = useNoteViewMode(false);

  /**
   * 本栏实际宽度，用来判分屏能不能用。
   *
   * ❗ 量**本栏**而不是 `window.innerWidth`：侧栏可以收起，收起后同一个窗口宽度下
   *   第三栏会宽 180px——拿窗口宽猜会在那个区间里猜错。
   */
  const paneRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setPaneWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 宽度还没量到（首帧）时不置灰：宁可晚一帧变灰，也不要闪一下。
  const splitDisabled = paneWidth > 0 && paneWidth < SPLIT_MIN_WIDTH;
  // 分屏下把窗口收窄了 ⇒ 自动退到预览，而不是留一个每边 150px 的碎屏。
  const effectiveMode = splitDisabled && viewMode === "split" ? "preview" : viewMode;

  /**
   * 把守卫与当前草稿同步给宿主。
   *
   * 依赖里带 `title` / `content` 是有意的（每敲一下都重跑，代价只是一次赋值）：
   * 窗口缩到 &lt;800px 时宿主要拿**当前**草稿转交给弹窗，拿到旧的等于没修。
   */
  useEffect(() => {
    onRegister?.({ guard: ed.guardSwitch, dirty: ed.isDirty, title: ed.title, content: ed.content });
    return () => onRegister?.(null);
  }, [onRegister, ed.guardSwitch, ed.isDirty, ed.title, ed.content]);

  /** 历史视图（B1 #4）。切过去只是换掉编辑区，`ed` 不重建，所以草稿还在。 */
  const [showHistory, setShowHistory] = useState(false);
  /** W4a：把编辑区换成冲突对照。与 `showHistory` 同一个形状（不叠弹窗）。 */
  const [showConflict, setShowConflict] = useState(false);

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
      ref={paneRef}
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
        {/* 形态切换器。**放头部**，与全屏 Markdown 编辑器的工具栏位置一致；
            按钮本身走同一份 `TRI_MODES`。 */}
        <NoteViewModeSwitch
          value={effectiveMode}
          onChange={setViewMode}
          splitDisabled={splitDisabled}
        />
        {/* 置顶 / 移动 / 删除。收成一个 `⋯` 而不是平铺三个按钮：
            800px 窗口（侧栏开着）时本栏只有 ~313px，头部可用 293，
            已经装了标题框 + 形态切换器 + 关闭；再加一个按钮就把标题框
            从 175px 压到 143px（约 9 个汉字），加两个就到 111px，不能用了。

            ❗ 不给 `tabIndex={-1}`，与行悬停条上那三个**相反**：
              行上必须 -1（列表里上百行，Tab 会停上百次），而本头部只有一份，
              Tab 停一次是应该的——所以它不需要再配一个 P/M 快捷键。 */}
        {buildMenu && ctxTrigger && (
          <button
            type="button"
            ref={moreRef}
            className={styles.moreBtn}
            onClick={() => {
              // 锚点公式与行悬停条上的 `⋯` 逐字相同（NoteList.tsx）。
              const r = moreRef.current?.getBoundingClientRect();
              ctxTrigger(r ? r.left : 0, r ? r.bottom + 2 : 0, buildMenu(note));
            }}
            title="更多（置顶 / 移动 / 删除）"
            aria-label="更多操作"
          >
            <MoreHorizontal size={14} />
          </button>
        )}
        {/* 关闭按钮：第三栏不是弹窗，但仍需要一个「我看完了」的出口，
            否则必须选另一条才能离开当前这条。
            ❗ 它必须是最右那个——全应用（弹窗 / 面板 / 问答栏）的 ✕ 都在最右，
              把它挤到中间会让「关闭」变成需要找的按钮。 */}
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

      {/* 搜索 / 切文件夹后这条可能已不在旁边列表里，而列表里也就没有对应的
          高亮行了。不清选中（那会丢草稿），只把这件事说出来。

          ❗ 从 `.head` 里搬到这里（2026-09-07 批 4），两个理由：
          ① `.head` 里其余三样（标题框 / 形态切换器 / 关闭）都是**常驻控件**，
            而它是**临时状态提示**，本不是一类东西；下面这组（摘要行 / 来源行）
            已经就是「条件出现的面板级信息行」这个模式。
          ② 它在 `.head` 里是 `flex-shrink: 0` 的 77px，800px 窗口（侧栏开着）下
            会把标题框压到 60px（约 3 个字）—— 挂了头部那个 `⋯` 之后更糟。

          搬下来后横向不再紧，于是把原本只写在 `title` 里的**整句话直接显示出来**：
          旧写法是「不在当前列表」6 个字 + 一个悬停才看得到的 tooltip，
          而靠悬停才能读到的解释等于大多数人读不到。 */}
      {notInList && (
        <div className={styles.notInListRow}>
          <EyeOff size={12} className={styles.notInListIcon} />
          <span>搜索或筛选变了，左侧列表里现在没有这一条</span>
        </div>
      )}

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

      {/* W4a 入口：只在编辑视图下出现。判据拿 `ed.content`（编辑器里的当前值），
          与传给对照视图的是同一份 —— 否则会出现「横幅说是副本、点进去却解不出」。 */}
      {!showHistory && !showConflict && isConflictCopy(ed.content) && (
        <NoteConflictBanner onOpen={() => setShowConflict(true)} />
      )}

      {showConflict ? (
        <NoteConflictView
          copyId={note.id}
          copyContent={ed.content}
          onBack={() => setShowConflict(false)}
          onResolved={(originId) => {
            setShowConflict(false);
            onSaved();
            // 🔴 副本已经被软删了，这一栏**绝不能停在它上**。
            //
            // 旧写法是 `if (onOpenNote) onOpenNote(originId);` —— 既不 await
            // 也不看返回值（那时候类型还是 `void`，根本接不到）。
            // 宿主的 `handleOpen` 带脏数据守卫，它完全可能返回 false：
            // 内容已经写进原笔记、副本已软删，但离开时弹「有未保存的修改」、
            // 用户选「留在这条」 ⇒ 面板停在一条已删的行上，
            // 此后任何保存都因 `WHERE deleted_at IS NULL` 硬失败。
            //
            // `void (async ...)()` 而不是把 onResolved 改成 async：
            // 跟本仓其它处同一个惯例（如 `onOpen={(n) => void handleOpenNote(n)}`）。
            if (!onOpenNote) {
              onClose();
              return;
            }
            void (async () => {
              if (!(await onOpenNote(originId))) onClose();
            })();
          }}
        />
      ) : showHistory ? (
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
          viewMode={effectiveMode}
          onChange={ed.setContent}
          onSave={handleSave}
        />
      )}

      {/* 反链（M3-④）放在编辑器下方、footer 之上：
          反链数量不定（0～N），放顶部会挤压正文；
          而阅读顺序也是先看正文、再看谁引用了我。 */}
      <NoteBacklinks noteId={note.id} onOpenNote={onOpenNote} />

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
