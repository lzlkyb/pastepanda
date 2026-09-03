/**
 * useNoteDetail — 第三栏的归属与守卫（A-60 从 KnowledgeView 拆出）。
 *
 * 一句话职责：第三栏里开着哪条 + 未保存守卫 + 窄屏时降级到弹窗。
 *
 * 🔴 守卫是这个 hook 存在的理由：`NoteDetailPane` 带 `key={note.id}`，
 *   换一条就重挂载，未保存的编辑会随组件一起**静默**消失。
 *   而能换掉第三栏的入口有好几个（点另一条、发问、回到回答、点参考笔记…），
 *   所以 `guardSwitch` 必须是个能传给其它模块的稳定函数，而不是只在✕ 那一处做检查。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogStore } from "@/stores/dialogStore";
import { noteTouch, type Note } from "@/lib/api";

/** 第三栏交上来的守卫 + 当前草稿。`null` = 第三栏没开着。 */
export interface NoteDetailHandle {
  guard: () => Promise<boolean>;
  dirty: boolean;
  title: string;
  content: string;
}

export interface NoteDetailOpts {
  /** ≥800px（有第三栏）。窄屏时 `activeNote` 永远为 null。 */
  hasDetailPane: boolean;
  /** 当前已加载的列表。算 `activeNotInList` 用。 */
  notes: Note[];
}

export function useNoteDetail({ hasDetailPane, notes }: NoteDetailOpts) {
  const openDialog = useDialogStore((s) => s.openNote);

  /** 第三栏里打开的那条。窄屏下永远为 null（那时走弹窗） */
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const detailRef = useRef<NoteDetailHandle | null>(null);

  // 稳引用：它进了 `NoteDetailPane` 的 effect 依赖，不稳就是每帧重跑。
  const registerDetail = useCallback((v: NoteDetailHandle | null) => {
    detailRef.current = v;
  }, []);

  /** 换掉第三栏前问一句。没开第三栏 / 没脏数据时直接放行。 */
  const guardSwitch = useCallback(async (): Promise<boolean> => {
    const g = detailRef.current?.guard;
    return g ? await g() : true;
  }, []);

  /** 第三栏是否有未保存改动。包成稳定函数：ref 的值必须在调用那一刻读。 */
  const isActiveDirty = useCallback(() => !!detailRef.current?.dirty, []);

  /** 把第三栏清掉（删了 / 让位给问答）。 */
  const clearActive = useCallback(() => setActiveNote(null), []);

  /**
   * 窗口从 ≥800 缩到 <800：第三栏消失，**当前笔记自动改为弹窗打开**。
   *
   * 不接这一条的话，用户正在写的东西会直接从屏上消失（设计稿 §10 行为细则）。
   */
  useEffect(() => {
    if (!hasDetailPane && activeNote) {
      // ✅ 把**当前草稿**交给弹窗，而不是库里的版本。
      // `openNote` 本来就收 title/content，而第三栏会把草稿交上来，
      // **不需要把草稿提到 store**。
      const d = detailRef.current;
      openDialog({
        noteId: activeNote.id,
        historyId: activeNote.history_id,
        title: d?.title ?? activeNote.title,
        content: d?.content ?? activeNote.content,
      });
      setActiveNote(null);
    }
  }, [hasDetailPane, activeNote, openDialog]);

  /**
   * 点一条笔记：宽屏进第三栏，窄屏走弹窗。
   *
   * 返回 `true` = 真的打开了，`false` = 被未保存守卫拦下了。
   * 调用方需要区分：窄第三栏下「打开了笔记」还要顺手把回答区折起来，
   * 而被拦下时什么都不应该变。
   */
  const handleOpen = useCallback(
    async (note: Note): Promise<boolean> => {
      // 宽屏下这一步会把第三栏换掉 ⇒ 先过守卫。放在 `noteTouch` **之前**：
      // 用户选了「留在这条」的话，那次阅读根本没发生，不能计进去。
      if (hasDetailPane && !(await guardSwitch())) return false;
      // 打开已有笔记 = 一次阅读（口径定义见 noteTouch 的注释）。
      // 写在两分支之前：宽屏进第三栏、窄屏走弹窗，两边都是打开。
      noteTouch(note.id);
      if (hasDetailPane) {
        setActiveNote(note);
        return true;
      }
      openDialog({
        noteId: note.id,
        historyId: note.history_id,
        title: note.title,
        content: note.content,
      });
      return true;
    },
    [hasDetailPane, openDialog, guardSwitch],
  );

  /**
   * 第三栏里那条已不在旁边列表的当前结果里（搜了词 / 切了文件夹）。
   *
   * 只看**已加载的** `notes`，所以翻页后它可能自己消失——可接受：
   * 提示消失意味着它真的出现在列表里了。
   */
  const activeNotInList = useMemo(
    () => !!activeNote && !notes.some((n) => n.id === activeNote.id),
    [activeNote, notes],
  );

  return {
    activeNote,
    activeNotInList,
    registerDetail,
    guardSwitch,
    isActiveDirty,
    clearActive,
    handleOpen,
  };
}
