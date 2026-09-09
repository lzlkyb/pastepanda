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
import { useToast, UNDO_WINDOW_MS } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { noteDelete, noteRestoreDeleted, noteSetFolder, noteTogglePin, type Note } from "@/lib/api";

/** 把标题塞进 toast 一行。按**码点**切，别把 emoji 劈成两半。 */
function clipTitle(s: string, n = 16): string {
  const cs = [...s];
  return cs.length <= n ? s : `${cs.slice(0, n).join("")}…`;
}

export interface NoteActionsOpts {
  /** 当前**已加载**的列表。范围选与 `selectedNotes` 都按它的下标/成员算。 */
  notes: Note[];
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
  const { notes, activeNote, isActiveDirty, clearActive, removeLocally, refreshAll } = opts;
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

  /**
   * 删之前要不要拦一下。
   *
   * 🔴 删除本身**不拦**（U4.1/U4.3）：后端 `note_delete` 是
   *   `UPDATE notes SET deleted_at`（软删），笔记进回收站，撤销就在 toast 上。
   *   能撤销的不要弹确认——确认框拦住的是**每一次正确的删除**，
   *   而撤销只在出错那一次付出成本。
   *
   * ❗ 但有**一段真的不可逆**：第三栏里那条未保存的修改。
   *   撤销恢复的是**库里的版本**，不包含这些改动，所以只在这种时候弹。
   */
  const guardDirty = useCallback(
    async (hit: boolean) => {
      if (!hit) return true;
      return await confirmDialog({
        title: "这条有未保存的修改",
        message:
          "笔记本身会进回收站、可以找回，但这些未保存的修改不行——\n撤销恢复的是库里的版本。",
        confirmText: "丢弃修改并删除",
        variant: "danger",
      });
    },
    [],
  );

  /**
   * 撤销删除：把刚删的那几条从回收站捞回来。
   *
   * 走的就是回收站面板那条路（`noteRestoreDeleted`），不新开接口——
   * 「恢复一条笔记」只该有一处实现（规则 #11.1）。
   * 部分失败不静默：捞回来几条就说几条（规则 #15.3）。
   */
  const undoDelete = useCallback(
    async (targets: Note[]) => {
      let ok = 0;
      for (const n of targets) {
        if (await noteRestoreDeleted(n.id, n.history_id)) ok++;
      }
      refreshAll();
      if (ok === targets.length) {
        toast(targets.length === 1 ? "已恢复" : `已恢复 ${ok} 条`, "success");
      } else {
        toast(`恢复了 ${ok} 条，${targets.length - ok} 条没能恢复`, "error");
      }
    },
    [refreshAll, toast],
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
      if (!(await guardDirty(activeNote?.id === note.id && isActiveDirty()))) return;
      if (!(await noteDelete(note.id, note.history_id))) return;
      removeLocally(note.id);
      // 删的正好是第三栏里那条 → 回空态。**不自动跳下一条**：
      // 自动跳转会让用户以为删错了（设计稿 §10）。
      if (activeNote?.id === note.id) clearActive();
      refreshAll();
      // 回执里不再写「会进回收站，N 天内可恢复」——那句话归回收站面板说（它那儿已经写了，
      // 还带逐条倒计时）。这里要回答的只有一件事：**删错了现在怎么办**。
      toast(
        `已删除「${clipTitle(note.title)}」`,
        "success",
        UNDO_WINDOW_MS,
        () => void undoDelete([note]),
        "撤销",
      );
    },
    [
      activeNote,
      isActiveDirty,
      guardDirty,
      undoDelete,
      toast,
      removeLocally,
      clearActive,
      refreshAll,
    ],
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
    // 同单条：删 N 条也是可撤销的，不拦；只有未保存的修改那一段不可逆。
    if (!(await guardDirty(!!activeNote && selectedIds.has(activeNote.id) && isActiveDirty())))
      return;
    // 只把**真删掉的**那几条交给撤销：把失败的也算进去，撤销时就会去恢复一条
    // 压根没删成的笔记，然后报一个莫名其妙的失败。
    const done: Note[] = [];
    let failed = 0;
    for (const n of targets) {
      if (await noteDelete(n.id, n.history_id)) done.push(n);
      else failed++;
    }
    if (activeNote && selectedIds.has(activeNote.id)) clearActive();
    clearSelection();
    refreshAll();
    // 不走 `reportBatch`：那个是给移动用的（移动靠高亮环回执、不需要撤销）。
    // 部分失败仍然要给撤销：已经删掉的那几条同样可能是误删（规则 #15.3）。
    const undo = done.length > 0 ? () => void undoDelete(done) : undefined;
    if (failed > 0) {
      toast(`已删除 ${done.length} 条，${failed} 条失败`, "error", undefined, undo, undo && "撤销");
    } else {
      toast(`已删除 ${done.length} 条笔记`, "success", UNDO_WINDOW_MS, undo, "撤销");
    }
  }, [
    selectedNotes,
    guardDirty,
    undoDelete,
    isActiveDirty,
    toast,
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
