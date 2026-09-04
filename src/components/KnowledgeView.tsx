/**
 * KnowledgeView.tsx — 「知识」模式主体区（D15）。
 *
 * 本文件是**编排层**：把四个 hook 串起来、控断点、把三栏拼出来。
 * 它自己**不持有任何业务状态**（A-60 拆分）：
 *
 * - `useNoteQuery`   — 数据层：按 关键词/文件夹/标签/视图 拉列表与计数，管分页
 * - `useNoteDetail`  — 第三栏：开着哪条 + 未保存守卫 + 窄屏降级到弹窗
 * - `useNoteActions` — 选中集 + 单条/批量/拖拽的删、移、置顶
 * - `useKbQaPane`    — 问答占哪块屏幕（搜/问切换、第三栏归属、状态条）
 *
 * ❗ 四者的依赖是**单向**的，query → detail → actions → qaPane，
 *   所以能顺序调用、不需要 Context 或反向回调。改顺序会立刻报未定义。
 *
 * 布局三档（设计稿 §10，断点沿用 app.css 现有的 600 / 800）：
 * - <600px：侧栏可收（默认收），点笔记 → 弹窗
 * - 600–800px：侧栏常驻，点笔记 → 弹窗
 * - ≥800px：侧栏常驻 + **第三栏取代弹窗**
 *
 * ❗ 自带 `<ContextMenu>` Provider：项目里那个在 `CardList` 里，
 *   而 CardList 只在记录模式渲染——不自带的话知识模式根本没右键菜单。
 *   （同 NoteDialog 当时必须挂到 App 顶层的同类问题。）
 *
 * 🔴 红线：**搜索、筛选、列表全走本机 SQLite，不出网**。
 *   唯一的 AI 路径是问答雏形（B2 #10），详见 `useKbQaPane` 头部。
 */
import { useCallback, useRef, useState } from "react";
import { Sparkles, ChevronRight } from "lucide-react";
import { ScrollProvider } from "@/contexts/ScrollContext";
import { useSmoothScroll } from "@/hooks/useSmoothScroll";
import { BackToTop } from "@/components/BackToTop";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { useKbLayout } from "@/hooks/useKbLayout";
import { ContextMenu } from "@/components/ContextMenu";
import { KbInboxPanel } from "@/components/notes/KbInboxPanel";
import { KbSyncStatusBar } from "@/components/notes/KbSyncStatusBar";
import { FolderTree } from "@/components/notes/FolderTree";
import { NoteList } from "@/components/notes/NoteList";
import { TrashPanel } from "@/components/notes/TrashPanel";
import { BatchBar } from "@/components/notes/BatchBar";
import { KnowledgeToolbar } from "@/components/notes/KnowledgeToolbar";
import { KbQaPanel } from "@/components/notes/KbQaPanel";
import { KbThirdPane, useCanSplitPane } from "@/components/notes/KbThirdPane";
import { NoteFilterPanel } from "@/components/notes/NoteFilterPanel";
import { useKbMoreMenu } from "@/components/notes/kbMoreMenu";
import { useWideLayout } from "@/hooks/useWideLayout";
import { useNoteQuery } from "@/components/notes/useNoteQuery";
import { useNoteDetail } from "@/components/notes/useNoteDetail";
import { useNoteActions } from "@/components/notes/useNoteActions";
import { useKbQaPane } from "@/components/notes/useKbQaPane";
import { NoteListEmpty } from "@/components/notes/NoteListEmpty";
import { ViewControls, ViewChips } from "@/components/notes/ViewControls";
import {
  NOTE_GROUPS,
  NOTE_SORTS,
  isNoteViewFiltered,
  type NoteViewOpts,
} from "@/lib/notes/viewOpts";
import { NoteDetailPane, NoteDetailEmpty } from "@/components/notes/NoteDetailPane";
import type { Note } from "@/lib/api";
import styles from "./KnowledgeView.module.css";

export function KnowledgeView() {
  const layout = useKbLayout();
  const openDialog = useDialogStore((s) => s.openNote);

  /**
   * 列表的平滑滚动（与记录模式同一套物理惯性）。
   *
   * 两个 ref 都在这里而不在 NoteList 里：包层 div **总是渲染**（里面装列表或空态），
   * 这样 DOM 节点在本组件整个生命周期内稳定，不用给 hook 再搞一套
   * 「列表出现了吗」的依赖判断。
   */
  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const lenisRef = useSmoothScroll(scrollWrapRef, scrollContentRef);

  /**
   * 侧栏开合：**读 store，开关在顶栏 ☰**（与记录模式同一个按钮）。
   *
   * 原先是 `sidebarPinned || manualOpen`，宽屏强制常驻、**没任何办法收起**——
   * 想腾点地方给笔记列表也做不到。现在宽屏只是**默认展开**（store 初值看断点），
   * 之后用户说了算。
   */
  const sidebarOpen = useAppStore((s) => s.sidebarOpen.knowledge);

  /** 回收站保留天数。删除确认框要拿它说人话，**不能写死 30**（用户能改）。 */
  const trashDays = useAppStore((s) => s.config.note_trash_days);
  const kbSyncOn = useAppStore((s) => s.config.kb_sync_enabled);

  /** ① 数据层。 */
  const q = useNoteQuery();

  /** ② 第三栏（需要 `q.notes` 算「已不在列表里」）。 */
  const detail = useNoteDetail({ hasDetailPane: layout.hasDetailPane, notes: q.notes });

  /**
   * 第三栏能不能上下分栏（A-61 ①）。ref 住在这里而不在 `KbThirdPane` 里：
   * 下面的 `handleOpenNote` 要用 `canSplit`，放子组件里再上报就成环了。
   */
  const thirdRef = useRef<HTMLDivElement | null>(null);
  const canSplit = useCanSplitPane(thirdRef);

  /**
   * 回答区收起了。
   *
   * ❗ 住在编排层而不在 `useKbQaPane` 里：两个写入方——发问/点胶囊（展开）
   *   与点笔记（窄栏下收起），而后者的 handler 又要作为 `openNote` 传给前者。
   */
  const [qaCollapsed, setQaCollapsed] = useState(false);
  const toggleQaCollapsed = useCallback(() => setQaCollapsed((c) => !c), []);

  /**
   * 点一条笔记（列表与参考笔记共用）。
   *
   * 比 `detail.handleOpen` 多一件事：**窄第三栏下把回答区收起来**。
   * 不收的后果就是用户报的那个现象：点了卡片但回答还占着整栏，笔记看不见。
   * 能分栏时**不收**：两者本来就同时可见，那才是分栏的意义。
   * 靠 `handleOpen` 的返回值分辨被守卫拦下的情况——拦下时什么都不应该变。
   */
  const { handleOpen } = detail;
  const handleOpenNote = useCallback(
    async (n: Note): Promise<boolean> => {
      const opened = await handleOpen(n);
      if (opened && layout.hasDetailPane && !canSplit) setQaCollapsed(true);
      return opened;
    },
    [handleOpen, layout.hasDetailPane, canSplit],
  );

  /** ③ 对笔记做的所有事（需要 ① 的重拉与 ② 的守卫）。 */
  const act = useNoteActions({
    notes: q.notes,
    trashDays,
    activeNote: detail.activeNote,
    isActiveDirty: detail.isActiveDirty,
    clearActive: detail.clearActive,
    removeLocally: q.removeLocally,
    refreshAll: q.refreshAll,
  });

  /** ④ 问答雏形（B2 #10）。它占哪块屏幕的规则全在 `useKbQaPane` 里。 */
  const qaPane = useKbQaPane({
    hasDetailPane: layout.hasDetailPane,
    folderFilter: q.folderFilter,
    tagIds: q.tagIds,
    view: q.view,
    currentFolderName: q.currentFolderName,
    openNote: handleOpenNote,
    setCollapsed: setQaCollapsed,
  });
  const { qa } = qaPane;

  const newHint = q.newFolderId
    ? `新建空白笔记（落入「${q.currentFolderName}」）`
    : "新建空白笔记（落入未分类）";

  /**
   * 切到回收站。包 useCallback：它进了 `useKbMoreMenu` 的 useMemo 依赖。
   *
   * ❗ 先**解构**再当依赖，不能写 `[q]`：`useNoteQuery` 每次渲染都返一个
   *   新对象字面量，写 `[q]` 等于没包。而直接写 `[q.setFolderFilter]`
   *   过不了 `exhaustive-deps`（它看不出那个属性是稳定的，会要整个 `q`）。
   *   解构同时满足两边——`useKbQaPane` 里 `const { reset: qaReset } = qa` 就是这么写的。
   */
  const { setFolderFilter } = q;
  const showTrash = useCallback(() => setFolderFilter("trash"), [setFolderFilter]);

  /** 中栏「⋯」溢出菜单（A-61 ③）：导入 / 导出 / 回收站。 */
  const moreItems = useKbMoreMenu({
    refreshAll: q.refreshAll,
    trashCount: q.trashCount,
    onTrash: showTrash,
  });

  /** 「宽屏布局」一键（A-61 ④）。只在窄屏给按钮——宽屏已经是三栏了。 */
  const wide = useWideLayout();

  /**
   * 新建空白笔记（§8.2 #13）。十五个入口里**唯一与剪贴板无关**的创建路径。
   *
   * **宽屏下也走弹窗**（设计稿 §11）：第三栏靠 `key={note.id}` 活着，
   * 而新草稿压根没 id；为它造一个「草稿态」得多一套状态。
   * **此处不写库**：点了＋又关掉不该给用户留一条空笔记，
   * 真正的 INSERT 在保存时（`useNoteEditorState.save`）才发。
   */
  const handleNew = useCallback(() => {
    openDialog({
      noteId: null,
      historyId: null,
      folderId: q.newFolderId,
      title: "",
      content: "",
    });
  }, [openDialog, q.newFolderId]);

  return (
    // ScrollProvider 包在最外层（而不是只包回顶按钮）：
    // 弹窗的 `useModalScrollLock` 靠它拿到当前 Lenis 去暂停。
    // 不包的后果：开着笔记弹窗滚轮会穿透到后面的列表（Lenis 全局接管 wheel 的已知副作用）。
    <ScrollProvider scrollRef={scrollWrapRef} lenisRef={lenisRef}>
    {/* 自带 Provider：详见文件头部说明 */}
    <ContextMenu>
      <div className={styles.shell}>
        {/* ❗ **常挂载**，不写 `{sidebarOpen && ...}`：后者是硬挂硬消，做不了开合的
            宽度动画（记录模式的 Sidebar 就是 `width: 0 → 180px`）。
            开合交给 `open` prop + CSS。 */}
        <FolderTree
          open={sidebarOpen}
          folders={q.folders}
          unfiledCount={q.unfiled}
          totalCount={q.total}
          trashCount={q.trashCount}
          maxDepth={q.maxDepth}
          selected={q.folderFilter}
          onSelect={q.setFolderFilter}
          onChanged={q.refreshAll}
          landed={act.landedFolder}
          version={q.version}
          onDropNotes={(folderId, ids) => void act.handleDropNotes(folderId, ids)}
        />

        <div className={styles.wrap}>
          {/* 回收站把中栏整个换掉（W1）：它没有搜索 / 分组 / 筛选 / 新建，
              把工具栏留在上面会给人一堆在这里无意义（甚至会报空）的控件。
              候选条目已从 `notes_fts` 移除，搜也真的搜不到。 */}
          {q.folderFilter === "trash" ? (
            <TrashPanel onChanged={q.refreshAll} folders={q.folders} />
          ) : (
          <>
          {/* 同步状态与异常提示。放在工具条**之上**：它是全库级别的事实，
              与当前文件夹 / 筛选无关；放下面会让人以为它在描述这一屏的列表。
              开关关着或一台未配对时组件自己返回 null，不占位。 */}
          <KbSyncStatusBar
            enabled={!!kbSyncOn}
            onSearchConflicts={() => q.setKeyword("冲突副本")}
          />
          <KnowledgeToolbar
            folderName={q.currentFolderName}
            total={q.total}
            keyword={q.keyword}
            onKeyword={q.setKeyword}
            onNew={handleNew}
            newHint={newHint}
            moreItems={moreItems}
            showWideBtn={!layout.hasDetailPane}
            onWide={() => void wide.goWide()}
            controls={
              <ViewControls
                sort={{
                  options: NOTE_SORTS,
                  value: q.view.sort,
                  onChange: (v) => q.patchView({ sort: v as NoteViewOpts["sort"] }),
                }}
                group={{
                  options: NOTE_GROUPS,
                  value: q.view.groupBy,
                  onChange: (v) => q.patchView({ groupBy: v as NoteViewOpts["groupBy"] }),
                }}
                filterActive={isNoteViewFiltered(q.view, q.tagIds)}
                filterPanel={
                  <NoteFilterPanel
                    view={q.view}
                    onPatch={q.patchView}
                    allTags={q.allTags}
                    tagIds={q.tagIds}
                    onToggleTag={q.toggleTag}
                  />
                }
              />
            }
            chips={<ViewChips chips={q.chips} onClearAll={q.clearAllFilters} />}
            qaEnabled={qaPane.enabled}
            mode={qaPane.mode}
            onMode={(m) => void qaPane.handleMode(m)}
            question={qaPane.question}
            onQuestion={qaPane.setQuestion}
            onAsk={() => void qaPane.handleAsk(qaPane.question)}
          />

          {/* 查询进行中的 2px 进度线（只在**已有结果**时出）。

              为何需要它：骨架屏只在 `notes.length === 0` 时渲染，所以搜索 / 切筛选时
              列表会保持旧内容不动，直到三个并发查询（noteSearch + noteCountFiltered +
              noteGroupCounts）全部返回才整体替换——加上 200ms 防抖，慢的时候
              完全像是没反应。

              不换成骨架屏：已经有结果时把列表换掉会让内容消失，反而更慌。 */}
          {q.loading && q.notes.length > 0 && (
            <div className={styles.loadingBar} aria-hidden="true" />
          )}

          {/* 中栏那行极简状态条（B2 #10b）。

              它**不是装饰**：回答退到后面（窄屏点了返回列表）时，
              这条就是「回答还在」的唯一可见凭据与唯一入口。
              窄屏接管中栏时不出：面板就在眼前，再摆一条「去看回答」是噪声。

              ❗ 现在**只在窄屏出**（A-61 ①）：宽屏那条胶囊已经搬到第三栏顶部了。
                它指向的东西在第三栏，放在中栏是指错了地方。 */}
          {qaPane.inline && qaPane.mode === "ask" && qaPane.hasQa && !qaPane.takeover && (
            <button type="button" className={styles.qaBar} onClick={qaPane.showQa}>
              <Sparkles size={11} />
              {qaPane.barText}
              <ChevronRight size={12} className={styles.qaBarArrow} />
            </button>
          )}

          {/* 窄屏：回答**接管**中栏（取代待沉淀区与列表）。
              宽屏不走这里——它住第三栏，列表不让位。 */}
          {qaPane.inline && qaPane.takeover ? (
            <KbQaPanel
              variant="inline"
              session={qa.session}
              scopeLabel={qaPane.scopeLabel}
              busy={qa.busy}
              onAsk={qaPane.handleAsk}
              onConfirm={qa.confirmSend}
              onBack={() => qaPane.setTakeover(false)}
              onClose={() => {
                qaPane.setTakeover(false);
                qaPane.qaReset();
              }}
              onOpenNote={(id) => void qaPane.openRefNote(id)}
            />
          ) : (
            <>
          {/* 待沉淀区（§8.1 4️⃣）。一条候选都没时它自己返回 null */}
          <KbInboxPanel />

          {/* 批量动作条（A2）。只在真选中了东西时出现，不占常驻行高。
              用 `selectedNotes.length` 而不是 `selectedIds.size`：列表重拉后
              可能有 id 已不在当前结果里，拿 `size` 会报一个比实际能操作的多的数。 */}
          {act.selectedNotes.length > 0 && (
            <BatchBar
              count={act.selectedNotes.length}
              folders={q.folders}
              onMove={(id) => void act.handleBatchMove(id)}
              onDelete={() => void act.handleBatchDelete()}
              onClear={act.clearSelection}
            />
          )}

          {/* 滚动包层总是渲染（里面装列表或空态）：Lenis 要的两个节点得稳定存在。 */}
          <div className={styles.listWrap} ref={scrollWrapRef}>
            <div className={styles.listContent} ref={scrollContentRef}>
              {q.notes.length === 0 ? (
                <NoteListEmpty
                  loading={q.loading}
                  keyword={q.keyword}
                  folderFilter={q.folderFilter}
                />
              ) : (
                <NoteList
                  notes={q.notes}
                  folders={q.folders}
                  activeId={detail.activeNote?.id ?? null}
                  showFolderColumn={!sidebarOpen}
                  groupCounts={q.groupCounts}
                  hasMore={q.notes.length < q.total}
                  loadingMore={q.loadingMore}
                  onLoadMore={() => void q.loadMore()}
                  keyword={q.keyword}
                  onTagClick={q.toggleTag}
                  selectedIds={act.selectedIds}
                  onRowSelect={act.handleRowSelect}
                  onClearSelection={act.clearSelection}
                  onOpen={(n) => void handleOpenNote(n)}
                  onDelete={act.handleDelete}
                  onSetFolder={act.handleSetFolder}
                  onTogglePin={(n) => void act.handleTogglePin(n)}
                />
              )}
            </div>
          </div>

          {/* 🔴 回顶胶囊必须放在滚动容器**外面**。
              它是 `position: absolute`，而绝对定位元素虽然按包含块定位，却仍然属于
              那个容器的**可滚动内容**——放在 `.listWrap` 里的后果是一滚就跟着列表划走了。
              现在挂在 `.wrap`（不滚的中栏）上，位置不变但不再随滚。
              它不需要是滚动容器的 DOM 后代：Lenis 实例是从 ScrollProvider 拿的。 */}
          <BackToTop className={styles.backTop} />
            </>
          )}
          </>
          )}
        </div>

        {/* 第三栏（≥800px）。

            ✅ 不再是三元互斥的了（A-61 ①）：`KbThirdPane` 把问答与笔记**同时**装进去，
            宽屏上下分栏、窄栏靠折叠切换。谁占哪块的全部规则在那个组件里。

            空态也渲染——隐掉会让列表宽度在选中前后跳一下。
            key 必须带 note.id：CodeMirror 初值只在挂载时读一次 */}
        {layout.hasDetailPane && (
          <KbThirdPane
            paneRef={thirdRef}
            canSplit={canSplit}
            qaCollapsed={qaCollapsed}
            onToggleQaCollapsed={toggleQaCollapsed}
            qaBarText={qaPane.barText}
            qa={
              qaPane.mode === "ask" && qaPane.hasQa ? (
                <KbQaPanel
                  session={qa.session}
                  scopeLabel={qaPane.scopeLabel}
                  busy={qa.busy}
                  onAsk={qaPane.handleAsk}
                  onConfirm={qa.confirmSend}
                  onClose={qaPane.qaReset}
                  onCollapse={() => setQaCollapsed(true)}
                  onOpenNote={(id) => void qaPane.openRefNote(id)}
                />
              ) : null
            }
            main={
              detail.activeNote ? (
                <NoteDetailPane
                  key={detail.activeNote.id}
                  note={detail.activeNote}
                  onClose={detail.clearActive}
                  onSaved={q.refreshAll}
                  notInList={detail.activeNotInList}
                  onRegister={detail.registerDetail}
                />
              ) : (
                <NoteDetailEmpty />
              )
            }
          />
        )}
      </div>
    </ContextMenu>
    </ScrollProvider>
  );
}
