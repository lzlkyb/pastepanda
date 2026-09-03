/**
 * useNoteActions — 「对笔记做的事」全集（A-60 从 KnowledgeView 拆出）。
 *
 * 收了三类动作：
 * - **选中集**：多选 / Shift 范围选 / 清空（A2）
 * - **单条**：删除、移动到文件夹、置顶
 * - **多条**：批量删除、批量移动、拖拽落定
 *
 * ❗ 为什么单条和批量放在一起而不是拆两个 hook：
 *   「把笔记移到某个文件夹」现在有**三个**入口（行右键、批量条、拖到侧栏），
 *   它们必须共享同一套「落定后要做什么」（重拉 + 目标文件夹闪一下）。
 *   散在三处的话，加第四个入口时必漏（规则 #11.1 说的就是这个）。
 *
 * 落定回执（`landedFolder`）也在这里：它的三个写入点全是本文件里的移动动作，
 * 放到外面就得把 `flashFolder` 当参数传进来，反而多一层。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { noteDelete, noteSetFolder, noteTogglePin, type Note } from "@/lib/api";

export interface NoteActionsOpts {
  /** 当前**已加载**的列表。范围选与 `selectedNotes` 都按它的下标/成员算。 */
  notes: Note[];
  /** 回收站保留天数。删除确认框要拿它说人话，**不能写死 30**（用户能改）。 */
  trashDays: number;
  /** 第三栏里开着的那条。`null` = 没开（窄屏永远是 null）。 */
  activeNote: Note | null;
  /**
   * 第三栏是否有未保存改动。
   *
   * ❗ 是**函数**不是布尔：这个值存在 ref 里（改动不触发重渲），
   *   传布尔的话 `useCallback` 会把调用那一刻之前的旧快照闭包进去。
   */
  isActiveDirty: () => boolean;
  /** 删掉 / 移走的正好是第三栏那条时，把它清掉。 */
  clearActive: () => void;
  /** 从已加载列表里就地摘掉一条。重拉是异步的，这一步让它**立刻**消失。 */
  removeLocally: (id: string) => void;
  /** 重拉列表 + 侧栏 + 计数。所有写操作之后都要调。 */
  refreshAll: () => void;
}

export function useNoteActions(opts: NoteActionsOpts) {
  const { notes, trashDays, activeNote, isActiveDirty, clearActive, removeLocally, refreshAll } =
    opts;
  const { toast } = useToast();

  /**
   * 多选（A2）。
   *
   * ❗ `anchor` 是 Shift 范围选的起点。不存它就只能做「逐条切换」，
   *   而整理一批笔记的典型动作恰恰是「连选一段」。
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<number>(-1);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  /**
   * 列表行的点击（带修饰键）。
   *
   * 普通点击的行为**一字未改**（打开）——多选是叠在上面的能力，
   * 不能拿日常最高频的动作去换。
   */
  const handleRowSelect = useCallback(
    (index: number, mode: "toggle" | "range") => {
      setSelectedIds((cur) => {
        const next = new Set(cur);
        if (mode === "range" && anchorRef.current >= 0) {
          const [a, b] = [anchorRef.current, index].sort((x, y) => x - y);
          for (let i = a; i <= b; i++) {
            const n = notes[i];
            if (n) next.add(n.id);
          }
          return next;
        }
        const n = notes[index];
        if (!n) return next;
        if (next.has(n.id)) next.delete(n.id);
        else next.add(n.id);
        anchorRef.current = index;
        return next;
      });
    },
    [notes],
  );

  /** 选中集里真实存在的那几条。列表重拉后可能有 id 已不在当前结果里。 */
  const selectedNotes = useMemo(
    () => notes.filter((n) => selectedIds.has(n.id)),
    [notes, selectedIds],
  );

  /**
   * 刚刚有东西落进去的文件夹（操作回执）。`null` = 没有。
   *
   * 为何需要它：把一篇笔记移走后，它就从当前列表里**消失**了（如果正在按文件夹筛）。
   * 在这之前用户完全不知道到底成没成、移到哪了——在目标文件夹上闪一下就是回执。
   */
  const [landedFolder, setLandedFolder] = useState<string | null>(null);
  const landTimerRef = useRef(0);

  /** 环的动画是 0.95s（1.1s 后再清，给它跑完）。 */
  const flashFolder = useCallback((key: string) => {
    window.clearTimeout(landTimerRef.current);
    setLandedFolder(key);
    landTimerRef.current = window.setTimeout(() => setLandedFolder(null), 1100);
  }, []);

  // 卸载时清定时器：不清就是对已卸载组件 setState（React 会警告，且是真泄漏）。
  useEffect(() => () => window.clearTimeout(landTimerRef.current), []);

  /** 删除确认框里那句「删了还能找回」。单条与批量共用一份口径（规则 #11）。 */
  const keepText = useMemo(
    () =>
      trashDays > 0
        ? `会先移到回收站，${trashDays} 天内可以恢复。`
        : "会先移到回收站，可以随时恢复。",
    [trashDays],
  );

  /**
   * 部分失败**不静默**（规则 #15.3）：只报「已删除」的话，
   * 用户会以为全成了，而列表里还剩几条看上去像是刷新延迟。
   */
  const reportBatch = useCallback(
    (verb: string, total: number, failed: number) => {
      if (failed > 0) toast(`成功 ${total - failed} 条，${failed} 条失败`, "error");
      else toast(`已${verb} ${total} 条笔记`, "success");
    },
    [toast],
  );

  const handleDelete = useCallback(
    async (note: Note) => {
      // 🔴 不能说「此操作不可恢复」——后端 `note_delete` 是
      //   `UPDATE notes SET deleted_at`（**软删**），笔记进回收站。
      //   两个方向都坏：吓得用户不敢删（其实很安全），删完也不知道能找回。
      // 删的正好是第三栏里正在改的那条 ⇒ 未保存的修改也会一并没，得说出来。
      // （恢复回来的是库里的版本，不包含这些改动。）
      const draftWarn =
        activeNote?.id === note.id && isActiveDirty()
          ? "这条还有未保存的修改，会一并丢弃。"
          : "";
      const ok = await confirmDialog({
        title: "删除笔记",
        message: `删除笔记「${note.title}」？${keepText}原卡片不受影响。${draftWarn}`,
        confirmText: "删除",
      });
      if (!ok) return;
      if (!(await noteDelete(note.id, note.history_id))) return;
      toast("已删除笔记", "success");
      removeLocally(note.id);
      // 删的正好是第三栏里那条 → 回空态。**不自动跳下一条**：
      // 自动跳转会让用户以为删错了（设计稿 §10）。
      if (activeNote?.id === note.id) clearActive();
      refreshAll();
    },
    [activeNote, isActiveDirty, keepText, toast, removeLocally, clearActive, refreshAll],
  );

  const handleSetFolder = useCallback(
    async (note: Note, folderId: string | null) => {
      if (!(await noteSetFolder(note.id, folderId))) return;
      refreshAll();
      // 侧栏里「未分类」的 key 是字符串 "unfiled"，不是 null（同 FolderFilter 的口径）。
      flashFolder(folderId ?? "unfiled");
    },
    [refreshAll, flashFolder],
  );

  /**
   * 切换置顶（B1）。
   *
   * ❗ 必须 `refreshAll` 而不能只改本地 state：置顶会改变它在列表里的**位置**
   *   （`ORDER BY notes.pinned DESC`），只翻个徽标会让行原地不动——看上去像置顶没生效。
   * 不弹 toast：行跳到顶部 + 徽标出现已经是足够清楚的回执了。
   */
  const handleTogglePin = useCallback(
    async (note: Note) => {
      if ((await noteTogglePin(note.id)) === null) return;
      refreshAll();
    },
    [refreshAll],
  );

  /**
   * 批量删除。循环调单条 `noteDelete` 而**不新增批量 IPC**：
   * 个人规模下几十次 IPC 无感，而新增一个批量命令就多一条需要单独守
   * 软删语义与 FTS 同步的路径（规则 #11.1）。
   */
  const handleBatchDelete = useCallback(async () => {
    const targets = selectedNotes;
    if (targets.length === 0) return;
    const ok = await confirmDialog({
      title: `删除 ${targets.length} 条笔记？`,
      message: `${keepText}原卡片不受影响。`,
      confirmText: `删除 ${targets.length} 条`,
      variant: "danger",
    });
    if (!ok) return;
    let failed = 0;
    for (const n of targets) {
      if (!(await noteDelete(n.id, n.history_id))) failed++;
    }
    reportBatch("删除", targets.length, failed);
    if (activeNote && selectedIds.has(activeNote.id)) clearActive();
    clearSelection();
    refreshAll();
  }, [
    selectedNotes,
    keepText,
    reportBatch,
    activeNote,
    selectedIds,
    clearActive,
    clearSelection,
    refreshAll,
  ]);

  /** 批量移动。落定后复用现有的高亮环回执（A-56），不另做一套。 */
  const handleBatchMove = useCallback(
    async (folderId: string | null) => {
      const targets = selectedNotes;
      if (targets.length === 0) return;
      let failed = 0;
      for (const n of targets) {
        if (!(await noteSetFolder(n.id, folderId))) failed++;
      }
      reportBatch("移动", targets.length, failed);
      clearSelection();
      refreshAll();
      flashFolder(folderId ?? "unfiled");
    },
    [selectedNotes, reportBatch, clearSelection, refreshAll, flashFolder],
  );

  /**
   * 拖拽落定（A3）。走与批量移动完全相同的路径，只是目标集来自拖拽而不是选中态。
   *
   * ❗ 不复用 `handleBatchMove`：那个拿的是 `selectedNotes`，而拖一条**未选中**的行
   *   时选中集可能是空的。两者的「目标是谁」不同，合并只会多一个参数分支。
   */
  const handleDropNotes = useCallback(
    async (folderId: string | null, ids: string[]) => {
      let failed = 0;
      for (const id of ids) {
        if (!(await noteSetFolder(id, folderId))) failed++;
      }
      // 单条成功不弹 toast：高亮环已经把「去哪了」回答了，再弹一个是噪声。
      // 但**失败要说**，哪怕只有一条（规则 #15.3）。
      if (failed > 0 || ids.length > 1) reportBatch("移动", ids.length, failed);
      clearSelection();
      refreshAll();
      flashFolder(folderId ?? "unfiled");
    },
    [reportBatch, clearSelection, refreshAll, flashFolder],
  );

  return {
    selectedIds,
    selectedNotes,
    clearSelection,
    handleRowSelect,
    landedFolder,
    handleDelete,
    handleSetFolder,
    handleTogglePin,
    handleBatchDelete,
    handleBatchMove,
    handleDropNotes,
  };
}
