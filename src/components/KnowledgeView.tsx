/**
 * KnowledgeView.tsx — 「知识」模式主体区（D15）。
 *
 * 本文件是**编排层**：拉数据 + 控断点 + 把三块拼起来。具体渲染各自成文件
 * （FolderTree / NoteList / NoteDetailPane / KbInboxPanel），否则必破规则 #7。
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
 * 🔴 红线：无 AI。搜索、筛选、列表全走本机 SQLite。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { useKbLayout } from "@/hooks/useKbLayout";
import { ContextMenu } from "@/components/ContextMenu";
import { KbInboxPanel } from "@/components/notes/KbInboxPanel";
import { FolderTree } from "@/components/notes/FolderTree";
import { NoteList } from "@/components/notes/NoteList";
import { KnowledgeToolbar } from "@/components/notes/KnowledgeToolbar";
import { NoteListEmpty } from "@/components/notes/NoteListEmpty";
import { ViewControls, ViewChips, TriRow } from "@/components/notes/ViewControls";
import {
  DEFAULT_NOTE_VIEW,
  NOTE_GROUPS,
  NOTE_SORTS,
  noteViewChips,
  type NoteViewOpts,
} from "@/lib/notes/viewOpts";
import { NoteDetailPane, NoteDetailEmpty } from "@/components/notes/NoteDetailPane";
import { dailyFilterDate, isDailyFilter } from "@/components/notes/DailySection";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import {
  noteList,
  noteSearch,
  noteDelete,
  noteCountFiltered,
  noteSetFolder,
  folderList,
  folderUnfiledCount,
  folderMaxDepth,
  noteTouch,
  noteGroupCounts,
  type Note,
  type NoteFolder,
  type FolderFilter,
} from "@/lib/api";
import styles from "./KnowledgeView.module.css";

/** 一页拉多少。与后端 `clamp_limit` 的缺省一致。 */
const PAGE = 50;


export function KnowledgeView() {
  const layout = useKbLayout();
  const { toast } = useToast();
  const openNote = useDialogStore((s) => s.openNote);

  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [unfiled, setUnfiled] = useState(0);
  const [total, setTotal] = useState(0);
  const [maxDepth, setMaxDepth] = useState(3);
  const [keyword, setKeyword] = useState("");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [loading, setLoading] = useState(true);
  /** 第三栏里打开的那条。窄屏下永远为 null（那时走弹窗） */
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  /** 数据版本号。侧栏「今日速记」区自己拉数据，靠它知道什么时候该重拉（B2 #3） */
  const [version, setVersion] = useState(0);

  /**
   * 字段视图（B2 #9）。**不持久化**：筛选是一次性意图（「我现在找东西」）而不是偏好。
   * 持久化的坑是下次打开看到一个被筛过的列表却想不起来自己筛过——看起来像「笔记丢了」。
   * 侧栏的文件夹/标签选择现在也不持久化，口径一致。
   */
  const [view, setView] = useState<NoteViewOpts>(DEFAULT_NOTE_VIEW);
  /** 分组组头的**真实**条数（后端 GROUP BY，不是数已加载的行） */
  const [groupCounts, setGroupCounts] = useState<Map<string, number>>(new Map());
  const [loadingMore, setLoadingMore] = useState(false);

  /** 改一个维度。换成新对象而不是原地改：effect 靠引用比较决定要不要重拉。 */
  const patchView = useCallback((patch: Partial<NoteViewOpts>) => {
    setView((cur) => ({ ...cur, ...patch }));
  }, []);
  /** 已生效的选项 chips。**空数组 = 默认态**，chips 行自己不渲染（不占行高）。 */
  const chips = noteViewChips(view, patchView);

  /**
   * 侧栏开合：**读 store，开关在顶栏 ☰**（与记录模式同一个按钮）。
   *
   * 原先是 `sidebarPinned || manualOpen`，宽屏强制常驻、**没任何办法收起**——
   * 想腾点地方给笔记列表也做不到。现在宽屏只是**默认展开**（store 初值看断点），
   * 之后用户说了算。
   */
  const sidebarOpen = useAppStore((s) => s.sidebarOpen.knowledge);

  /** 拉文件夹与计数。文件夹增删改、笔记归档/删除后都要重拉。 */
  const reloadFolders = useCallback(async () => {
    const [fs, uf, mx] = await Promise.all([
      folderList(),
      folderUnfiledCount(),
      folderMaxDepth(),
    ]);
    setFolders(fs);
    setUnfiled(uf);
    setMaxDepth(mx);
  }, []);

  /** 拉笔记列表（第一页）。搜索与筛选叠加（选着文件夹搜就只在那里搜）。 */
  const reloadNotes = useCallback(
    async (kw: string, ff: FolderFilter, v: NoteViewOpts) => {
      setLoading(true);
      const kwTrim = kw.trim();
      const [rows, cnt, groups] = await Promise.all([
        kwTrim
          ? noteSearch(kwTrim, { folderFilter: ff, view: v, limit: PAGE })
          : noteList({ folderFilter: ff, view: v, limit: PAGE }),
        // 总数也要带 view：否则筛选后面包屑还显全库数，就是新的一个「数字对不上」
        noteCountFiltered({ folderFilter: ff, view: v }),
        noteGroupCounts({ folderFilter: ff, view: v }),
      ]);
      setNotes(rows);
      setTotal(cnt);
      setGroupCounts(groups);
      setLoading(false);
    },
    [],
  );

  /**
   * 加载更多（前置修复）。
   *
   * 改之前列表只拉 `PAGE = 50` 一页、无翻页无加载更多，而面包屑用的是真实总数，
   * 所以超过 50 条时面包屑说 60 、列表只给 50，**没任何提示**（同 A-32）。
   *
   * 用 `notes.length` 当 offset 而不另维一个计数：两个数一旦不同步就会跳页 / 重复。
   * ❗ 按标签分组时一条多标签的笔记会占多行，而 `total` 是 `COUNT(DISTINCT id)`，
   *   所以 `notes.length` 可能超过 total——这时 hasMore 为 false，正好停住。
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    const kwTrim = keyword.trim();
    const rows = kwTrim
      ? // 搜索没有 offset 参数（后端 `note_search` 只收 limit），改成抬高 limit 重拉。
        // 对搜索结果这么做可接受：它本来就有 MAX_PAGE 上限，且用户还在缩小范围。
        await noteSearch(kwTrim, {
          folderFilter,
          view,
          limit: notes.length + PAGE,
        })
      : await noteList({
          folderFilter,
          view,
          limit: PAGE,
          offset: notes.length,
        });
    setNotes((cur) => (kwTrim ? rows : [...cur, ...rows]));
    setLoadingMore(false);
  }, [folderFilter, keyword, loading, loadingMore, notes.length, view]);

  // 首次 + 关键词/筛选/视图变化（防抖 200ms：每个字一次 FTS 查询没必要）
  useEffect(() => {
    const t = window.setTimeout(
      () => void reloadNotes(keyword, folderFilter, view),
      keyword ? 200 : 0,
    );
    return () => window.clearTimeout(t);
  }, [keyword, folderFilter, view, reloadNotes]);

  useEffect(() => {
    void reloadFolders();
  }, [reloadFolders]);

  const refreshAll = useCallback(() => {
    void reloadNotes(keyword, folderFilter, view);
    void reloadFolders();
    setVersion((v) => v + 1);
  }, [keyword, folderFilter, view, reloadNotes, reloadFolders]);

  // 弹窗关闭后重拉（逻辑收在 useNoteDialogClosed，待沉淀面板用的是同一个）
  useNoteDialogClosed(refreshAll);

  /**
   * 窗口从 ≥800 缩到 <800：第三栏消失，**当前笔记自动改为弹窗打开**。
   *
   * 不接这一条的话，用户正在写的东西会直接从屏上消失（设计稿 §10 行为细则）。
   * 代价：第三栏里未保存的修改不会带过去——弹窗拿到的是库里的版本。
   * 要带过去得把草稿提到 store，而那会让两个壳共享一份可变草稿，得不偿失。
   */
  useEffect(() => {
    if (!layout.hasDetailPane && activeNote) {
      openNote({
        noteId: activeNote.id,
        historyId: activeNote.history_id,
        title: activeNote.title,
        content: activeNote.content,
      });
      setActiveNote(null);
    }
  }, [layout.hasDetailPane, activeNote, openNote]);

  /** 点一条笔记：宽屏进第三栏，窄屏走弹窗。 */
  const handleOpen = useCallback(
    (note: Note) => {
      // 打开已有笔记 = 一次阅读（口径定义见 noteTouch 的注释）。
      // 写在两分支之前：宽屏进第三栏、窄屏走弹窗，两边都是打开。
      noteTouch(note.id);
      if (layout.hasDetailPane) {
        setActiveNote(note);
        return;
      }
      openNote({
        noteId: note.id,
        historyId: note.history_id,
        title: note.title,
        content: note.content,
      });
    },
    [layout.hasDetailPane, openNote],
  );

  const handleDelete = useCallback(
    async (note: Note) => {
      const ok = await confirmDialog({
        title: "删除笔记",
        message: `删除笔记「${note.title}」？此操作不可恢复。原卡片不受影响。`,
        confirmText: "删除",
      });
      if (!ok) return;
      if (!(await noteDelete(note.id, note.history_id))) return;
      toast("已删除笔记", "success");
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      // 删的正好是第三栏里那条 → 回空态。**不自动跳下一条**：
      // 自动跳转会让用户以为删错了（设计稿 §10）。
      if (activeNote?.id === note.id) setActiveNote(null);
      refreshAll();
    },
    [activeNote, refreshAll, toast],
  );

  const handleSetFolder = useCallback(
    async (note: Note, folderId: string | null) => {
      if (!(await noteSetFolder(note.id, folderId))) return;
      refreshAll();
    },
    [refreshAll],
  );

  const currentFolderName = useMemo(() => {
    if (folderFilter === "all") return "全部笔记";
    if (folderFilter === "unfiled") return "未分类";
    if (folderFilter === "daily") return "今日速记";
    // 面包屑直接写日期：“今日速记 · 2026-09-01” 太长，180px 那栏装不下
    const day = dailyFilterDate(folderFilter);
    if (day) return day;
    return folders.find((f) => f.id === folderFilter)?.name ?? "全部笔记";
  }, [folderFilter, folders]);

  /**
   * 新建的笔记落在哪里（#13）。
   * 「全部」与「未分类」都不是真文件夹 ⇒ null（即未分类）。
   */
  // 速记筛选下新建也落未分类：`daily` 不是文件夹，拿它当 folder_id 会写出一个不存在的归属
  const newFolderId =
    folderFilter === "all" || folderFilter === "unfiled" || isDailyFilter(folderFilter)
      ? null
      : folderFilter;
  const newHint = newFolderId
    ? `新建空白笔记（落入「${currentFolderName}」）`
    : "新建空白笔记（落入未分类）";

  /**
   * 新建空白笔记（§8.2 #13）。十五个入口里**唯一与剪贴板无关**的创建路径。
   *
   * **宽屏下也走弹窗**（设计稿 §11）：第三栏靠 `key={note.id}` 活着，
   * 而新草稿压根没 id；为它造一个「草稿态」得多一套状态。
   * **此处不写库**：点了＋又关掉不该给用户留一条空笔记，
   * 真正的 INSERT 在保存时（`useNoteEditorState.save`）才发。
   */
  const handleNew = useCallback(() => {
    openNote({ noteId: null, historyId: null, folderId: newFolderId, title: "", content: "" });
  }, [openNote, newFolderId]);

  return (
    // 自带 Provider：详见文件头部说明
    <ContextMenu>
      <div className={styles.shell}>
        {sidebarOpen && (
          <FolderTree
            folders={folders}
            unfiledCount={unfiled}
            totalCount={total}
            maxDepth={maxDepth}
            selected={folderFilter}
            onSelect={setFolderFilter}
            onChanged={refreshAll}
            version={version}
          />
        )}

        <div className={styles.wrap}>
          <KnowledgeToolbar
            folderName={currentFolderName}
            total={total}
            keyword={keyword}
            onKeyword={setKeyword}
            onNew={handleNew}
            newHint={newHint}
            controls={
              <ViewControls
                sort={{
                  options: NOTE_SORTS,
                  value: view.sort,
                  onChange: (v) => patchView({ sort: v as NoteViewOpts["sort"] }),
                }}
                group={{
                  options: NOTE_GROUPS,
                  value: view.groupBy,
                  onChange: (v) => patchView({ groupBy: v as NoteViewOpts["groupBy"] }),
                }}
                filterActive={!!(view.summary || view.fromCard || view.tagged)}
                filterPanel={
                  <>
                    <TriRow
                      label="摘要"
                      value={view.summary}
                      yesText="有摘要"
                      noText="无摘要"
                      onChange={(v) => patchView({ summary: v })}
                    />
                    <TriRow
                      label="来源"
                      value={view.fromCard}
                      yesText="来自卡片"
                      noText="手工新建"
                      onChange={(v) => patchView({ fromCard: v })}
                    />
                    <TriRow
                      label="标签"
                      value={view.tagged}
                      yesText="有标签"
                      noText="无标签"
                      onChange={(v) => patchView({ tagged: v })}
                    />
                  </>
                }
              />
            }
            chips={<ViewChips chips={chips} onClearAll={() => setView(DEFAULT_NOTE_VIEW)} />}
          />

          {/* 待沉淀区（§8.1 4️⃣）。一条候选都没时它自己返回 null */}
          <KbInboxPanel />

          {notes.length === 0 ? (
            <NoteListEmpty loading={loading} keyword={keyword} folderFilter={folderFilter} />
          ) : (
            <NoteList
              notes={notes}
              folders={folders}
              activeId={activeNote?.id ?? null}
              showFolderColumn={!sidebarOpen}
              groupCounts={groupCounts}
              hasMore={notes.length < total}
              loadingMore={loadingMore}
              onLoadMore={() => void loadMore()}
              onOpen={handleOpen}
              onDelete={handleDelete}
              onSetFolder={handleSetFolder}
            />
          )}
        </div>

        {/* 第三栏（≥800px）。空态也渲染——隐掉会让列表宽度在选中前后跳一下。
            key 必须带 note.id：CodeMirror 初值只在挂载时读一次 */}
        {layout.hasDetailPane &&
          (activeNote ? (
            <NoteDetailPane
              key={activeNote.id}
              note={activeNote}
              onClose={() => setActiveNote(null)}
              onSaved={refreshAll}
            />
          ) : (
            <NoteDetailEmpty />
          ))}
      </div>
    </ContextMenu>
  );
}
