/**
 * useNoteQuery — 知识库的**数据层**（A-60 从 KnowledgeView 拆出）。
 *
 * 一句话职责：按 关键词 / 文件夹 / 标签 / 视图 拉列表与计数，并管分页。
 *
 * 四个筛选维度**全部不持久化**：筛选是一次性意图（「我现在找东西」）而不是偏好。
 * 持久化的坑是下次打开看到一个被筛过的列表却想不起来自己筛过——看起来就像「笔记丢了」。
 *
 * 🔴 红线：这一层**全走本机 SQLite，一步不出网**。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { dailyFilterDate, isDailyFilter } from "@/components/notes/DailySection";
import {
  DEFAULT_NOTE_VIEW,
  noteViewChips,
  type NoteViewOpts,
  type ViewChip,
} from "@/lib/notes/viewOpts";
import {
  noteList,
  noteSearch,
  noteCountFiltered,
  folderList,
  folderUnfiledCount,
  folderMaxDepth,
  noteGroupCounts,
  noteCountDeleted,
  type Note,
  type NoteFolder,
  type FolderFilter,
} from "@/lib/api";

/** 一页拉多少。与后端 `clamp_limit` 的缺省一致。 */
const PAGE = 50;

export function useNoteQuery() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [unfiled, setUnfiled] = useState(0);
  /** 回收站条数（W1）。跟着 `reloadFolders` 一起刷。 */
  const [trashCount, setTrashCount] = useState(0);
  const [total, setTotal] = useState(0);
  // 初值只是拿到后端值之前的占位（权威是 `MAX_FOLDER_DEPTH`）。
  // 写对一点能避免第一帧用错的上限算可移动目标。
  const [maxDepth, setMaxDepth] = useState(4);
  const [keyword, setKeyword] = useState("");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  /** 标签筛选（A1）。**多标签是 AND**（后端 `push_note_filters` 的口径）。 */
  const [tagIds, setTagIds] = useState<string[]>([]);
  /** 字段视图（B2 #9）：排序 + 分组 + 四个筛选维度。 */
  const [view, setView] = useState<NoteViewOpts>(DEFAULT_NOTE_VIEW);
  /** 分组组头的**真实**条数（后端 GROUP BY，不是数已加载的行） */
  const [groupCounts, setGroupCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 数据版本号。侧栏「今日速记」区自己拉数据，靠它知道什么时候该重拉（B2 #3） */
  const [version, setVersion] = useState(0);

  /** 改一个维度。换成新对象而不是原地改：effect 靠引用比较决定要不要重拉。 */
  const patchView = useCallback((patch: Partial<NoteViewOpts>) => {
    setView((cur) => ({ ...cur, ...patch }));
  }, []);

  /** 全部标签（给筛选浮层与 chips 用）。跟记录模式同一份数据源。 */
  const allTags = useAppStore((s) => s.tags);

  /** 切一个标签的选中。列表行内的徽标与筛选浮层都走它（规则 #11）。 */
  const toggleTag = useCallback((id: string) => {
    setTagIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  /** 一键回默认态。**必须连标签一起清**：标签 chip 就在 chips 那一行里摆着，
   * 只清一半的话用户会以为按钮坏了。 */
  const clearAllFilters = useCallback(() => {
    setView(DEFAULT_NOTE_VIEW);
    setTagIds([]);
  }, []);

  /**
   * 已生效的选项 chips。**空数组 = 默认态**，chips 行自己不渲染（不占行高）。
   *
   * 标签 chip 在这里拼而不是塞进 `noteViewChips`：后者只认 `NoteViewOpts`，
   * 而标签不在那个结构里（它是后端的独立参数 `tag_ids`）。
   * 硬塞进去就得让那个纯函数再收一份标签表，不值。
   */
  const chips = useMemo<ViewChip[]>(
    () => [
      ...noteViewChips(view, patchView),
      ...tagIds.map((id) => ({
        // 标签可能刚被删掉（另一个模式里），那就直接显 id 也不该崩。
        label: allTags.find((t) => t.id === id)?.name ?? "已删标签",
        onClear: () => toggleTag(id),
      })),
    ],
    [view, patchView, tagIds, allTags, toggleTag],
  );

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
    // 回收站计数跟着侧栏一起刷（W1）。单开一次查而不是拿
    // `noteListDeleted().length`：后者会为一个数字把 200 条笔记正文拉回来。
    setTrashCount(await noteCountDeleted());
  }, []);

  /**
   * 拉笔记列表（第一页）。搜索与筛选叠加（选着文件夹搜就只在那里搜）。
   *
   * 四个筛选值走**参数**而不是闭包读 state：这样它的 `useCallback` 依赖为空、
   * 引用永远稳定，否则它会进下面那个防抖 effect 的依赖里造成重复查询。
   */
  const reloadNotes = useCallback(
    async (kw: string, ff: FolderFilter, v: NoteViewOpts, tids: string[]) => {
      // ❗ 回收站不走笔记列表那套查询，必须在这里截住。
      //   `FolderFilter` 是 `"all" | "unfiled" | string`，末尾那个 `string`
      //   让整个类型坍缩成 `string`——**tsc 不会拦住 `"trash"` 流到后端**。
      //   不截的话后端会把它当成文件夹 id 去跑递归 CTE，查不到就
      //   **静默返回空列表**，不报错。本函数是四个消费点
      //   （noteList / noteSearch / noteCountFiltered / noteGroupCounts）的共同入口。
      if (ff === "trash") {
        setNotes([]);
        setGroupCounts(new Map());
        setLoading(false);
        return;
      }
      setLoading(true);
      const kwTrim = kw.trim();
      const [rows, cnt, groups] = await Promise.all([
        kwTrim
          ? noteSearch(kwTrim, { folderFilter: ff, tagIds: tids, view: v, limit: PAGE })
          : noteList({ folderFilter: ff, tagIds: tids, view: v, limit: PAGE }),
        // 总数也要带 view 与 tagIds：否则筛选后面包屑还显全库数，就是新的一个「数字对不上」
        noteCountFiltered({ folderFilter: ff, tagIds: tids, view: v }),
        noteGroupCounts({ folderFilter: ff, tagIds: tids, view: v }),
      ]);
      setNotes(rows);
      setTotal(cnt);
      setGroupCounts(groups);
      setLoading(false);
    },
    [],
  );

  /**
   * 加载更多。
   *
   * 改之前列表只拉 `PAGE = 50` 一页、无翻页无加载更多，而面包屑用的是真实总数，
   * 所以超过 50 条时面包屑说 60 、列表只给 50，**没任何提示**（同 A-32）。
   *
   * 用 `notes.length` 当 offset 而不另维一个计数：两个数一旦不同步就会跳页 / 重复。
   * ❗ 按标签分组时一条多标签的笔记会占多行，而 `total` 是 `COUNT(DISTINCT id)`，
   *   所以 `notes.length` 可能超过 total——这时 hasMore 为 false，正好停住。
   */
  const loadMore = useCallback(async () => {
    // 同上：回收站没有分页。正常路径下 LoadMoreSentinel 根本不会渲染（中栏换成了
    // TrashPanel），这句是规则 #11.1 的兜底：folderFilter 的每个消费点都要拦。
    if (folderFilter === "trash" || loadingMore || loading) return;
    setLoadingMore(true);
    const kwTrim = keyword.trim();
    const rows = kwTrim
      ? // 搜索没有 offset 参数（后端 `note_search` 只收 limit），改成抬高 limit 重拉。
        // 对搜索结果这么做可接受：它本来就有 MAX_PAGE 上限，且用户还在缩小范围。
        await noteSearch(kwTrim, {
          folderFilter,
          tagIds,
          view,
          limit: notes.length + PAGE,
        })
      : await noteList({
          folderFilter,
          tagIds,
          view,
          limit: PAGE,
          offset: notes.length,
        });
    setNotes((cur) => (kwTrim ? rows : [...cur, ...rows]));
    setLoadingMore(false);
  }, [folderFilter, keyword, loading, loadingMore, notes.length, view, tagIds]);

  // 首次 + 关键词/筛选/视图变化（防抖 200ms：每个字一次 FTS 查询没必要）
  useEffect(() => {
    const t = window.setTimeout(
      () => void reloadNotes(keyword, folderFilter, view, tagIds),
      keyword ? 200 : 0,
    );
    return () => window.clearTimeout(t);
  }, [keyword, folderFilter, view, tagIds, reloadNotes]);

  useEffect(() => {
    void reloadFolders();
  }, [reloadFolders]);

  const refreshAll = useCallback(() => {
    void reloadNotes(keyword, folderFilter, view, tagIds);
    void reloadFolders();
    setVersion((v) => v + 1);
  }, [keyword, folderFilter, view, tagIds, reloadNotes, reloadFolders]);

  // 弹窗关闭后重拉（逻辑收在 useNoteDialogClosed，待沉淀面板用的是同一个）
  useNoteDialogClosed(refreshAll);

  /** 从已加载列表里就地摘掉一条（删除后的即时反馈，不等重拉）。 */
  const removeLocally = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const currentFolderName = useMemo(() => {
    if (folderFilter === "all") return "全部笔记";
    if (folderFilter === "unfiled") return "未分类";
    if (folderFilter === "daily") return "今日速记";
    // 回收站实际不走工具栏（中栏整个换成了 TrashPanel），这一行是为了
    // 不让它静默落到下面那个「全部笔记」兜底上——那种错很难查。
    if (folderFilter === "trash") return "回收站";
    // 面包屑直接写日期：“今日速记 · 2026-09-01” 太长，180px 那栏装不下
    const day = dailyFilterDate(folderFilter);
    if (day) return day;
    return folders.find((f) => f.id === folderFilter)?.name ?? "全部笔记";
  }, [folderFilter, folders]);

  /**
   * 新建的笔记落在哪里（#13）。
   * 「全部」与「未分类」都不是真文件夹 ⇒ null（即未分类）。
   * 速记筛选下也落未分类：`daily` 不是文件夹，拿它当 folder_id 会写出一个不存在的归属。
   */
  const newFolderId =
    folderFilter === "all" || folderFilter === "unfiled" || isDailyFilter(folderFilter)
      ? null
      : folderFilter;

  return {
    // 数据
    notes,
    folders,
    unfiled,
    trashCount,
    total,
    maxDepth,
    groupCounts,
    loading,
    loadingMore,
    version,
    // 筛选态
    keyword,
    setKeyword,
    folderFilter,
    setFolderFilter,
    tagIds,
    toggleTag,
    view,
    patchView,
    allTags,
    chips,
    clearAllFilters,
    // 衍生
    currentFolderName,
    newFolderId,
    // 动作
    loadMore,
    refreshAll,
    removeLocally,
  };
}
