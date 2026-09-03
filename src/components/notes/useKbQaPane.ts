/**
 * useKbQaPane — 问答雏形的**编排层**（A-60 从 KnowledgeView 拆出）。
 *
 * 与 `useKbQa` 的分工：
 * - `useKbQa`（src/hooks/）管**会话本身**——检索、发问、轮次、确认发送
 * - 本 hook 管**它占哪块屏幕**——搜/问切换、谁占第三栏、窄屏接不接管中栏、状态条
 *
 * 🔴 红线：受 `ai_enabled` 门控（规则 #16）——关着时 `enabled` 为 false，
 *   调用方要让切换器**整个不渲染**（不是置灰）。
 *   而且即使开着，**检索那一步仍在本机**（FTS5 + BM25）；
 *   出网的只有「问题 + 命中的笔记片段」那一段。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useKbQa } from "@/hooks/useKbQa";
import { isAiAvailable } from "@/lib/transforms";
import { confirmDialog } from "@/lib/confirm";
import { isNoteViewFiltered, type NoteViewOpts } from "@/lib/notes/viewOpts";
import type { KnowledgeMode } from "@/components/notes/KnowledgeToolbar";
import { noteGet, type FolderFilter, type Note } from "@/lib/api";

export interface KbQaPaneOpts {
  /** ≥800px（有第三栏）。决定回答是住第三栏还是接管中栏。 */
  hasDetailPane: boolean;
  /** 检索范围三件套。跟着当前筛选走（同搜索与文件夹的叠加口径）。 */
  folderFilter: FolderFilter;
  tagIds: string[];
  view: NoteViewOpts;
  /** 面包屑上那个名字。回答卡底部的「当前范围」拿它拼。 */
  currentFolderName: string;
  /** 打开一条笔记（宽屏进第三栏 / 窄屏走弹窗）。点参考笔记用。 */
  openNote: (n: Note) => Promise<boolean>;
  /**
   * 展开 / 收起回答区。
   *
   * ❗ 这个状态**住在 `KnowledgeView`** 而不在本 hook 里，因为有两个写入方：
   *   本 hook（发问 / 点胶囊 → 展开）与点笔记那条路径（窄栏下 → 收起）。
   *   而点笔记的 handler 又要作为 `openNote` 传进来——放在本 hook 里就是个环。
   *   共享状态住在最近的共同祖先，这里就是编排层。
   */
  setCollapsed: (v: boolean) => void;
}

export function useKbQaPane(opts: KbQaPaneOpts) {
  const { hasDetailPane, folderFilter, tagIds, view, currentFolderName, openNote, setCollapsed } =
    opts;

  const [mode, setMode] = useState<KnowledgeMode>("search");
  // 问题与 `keyword` 分开存：共用一个值的话，切回搜模式会拿整句问题去搜（AND 语义、必然零结果）
  const [question, setQuestion] = useState("");

  /** 规则 #16：AI 关着时切换器整个不渲染（不是置灰） */
  const enabled = isAiAvailable();

  // 问答的检索范围跟着标签筛选走：筛着一个标签提问时，用户的预期是「在这些里问」，
  // 而不是突然跳出当前范围。
  // ❗ `tagIds` 是 useState 的数组，引用稳定；千万别在这里写行内 `[]`，
  //   那会每次渲染都是新引用，把 `useKbQa` 里的 useCallback 全部失效。
  const scope = useMemo(() => ({ folderFilter, tagIds, view }), [folderFilter, tagIds, view]);
  const qa = useKbQa(scope);
  const { reset: qaReset, ask: qaAsk } = qa;

  /**
   * 窄屏（&lt;800px）下回答是否正接管着中栏。
   *
   * 不用弹窗：窄屏本来就只有一栏，「占一整栏」的正确形态就是接管它，
   * 而且省掉 portal / FocusTrap / z-index / 滚动锁那一整套。
   * 宽屏不用它：回答直接住第三栏，列表一直在旁边。
   */
  const [takeover, setTakeover] = useState(false);

  /**
   * 🔴 跳到宽屏时把 `takeover` 清掉（A-61 附带修的 bug）。
   *
   * 不清的后果：窄屏用过问答接管中栏 → 拉宽 → 再缩窄，中栏会**突然**
   * 被问答接管，而用户早就不在问答里了——看起来就是列表无故消失。
   */
  useEffect(() => {
    if (hasDetailPane) setTakeover(false);
  }, [hasDetailPane]);

  /** 窄屏档（没第三栏）。单拿出来命名，比满屏的 `!hasDetailPane` 好读 */
  const inline = !hasDetailPane;

  /** 会话里有东西（已答过 or 正在跑）。决定第三栏要不要给问答、状态条要不要出 */
  const hasQa = qa.session.turns.length > 0 || qa.session.pending !== null;

  /** 状态条文案。抽出来算：嵌在 JSX 里的三层三元没人读得懂 */
  const barText = useMemo(() => {
    if (qa.busy) return "正在回答…";
    const turns = qa.session.turns;
    const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
    const refPart = last && last.refs.length > 0 ? ` · 参考 ${last.refs.length} 篇` : "";
    return `已回答 ${turns.length} 轮${refPart}`;
  }, [qa.busy, qa.session.turns]);

  /**
   * 回答卡底部的「当前范围」。不写它的话，筛着一个文件夹没命中时用户会以为全库都没有。
   *
   * 判「算不算筛过」走公共函数 `isNoteViewFiltered`（规则 #11）：
   * 原先这里自己写了一串布尔或，漏了标签与修改时间两个维度。
   */
  const scopeLabel = useMemo(
    () => (isNoteViewFiltered(view, tagIds) ? `${currentFolderName} · 已筛选` : currentFolderName),
    [currentFolderName, view, tagIds],
  );

  // 依赖取 `qa.reset` 而不是 `qa`：`useKbQa` 每次渲染都返新对象字面量，
  // 写 `[qa]` 的 useCallback 等于没包；`reset` 本身是稳定的。
  const handleMode = useCallback(
    async (m: KnowledgeMode) => {
      // ❗ 切回搜模式会丢掉整个会话，而「搜」「问」两个按钮紧挨着、各只有 8px
      //   内边距——误点一次的代价是整段对话，而且不可撤销。
      //   没轮次时不问（没东西可丢），那才是绝大多数情况。
      if (m === "search" && hasQa) {
        const ok = await confirmDialog({
          title: "丢弃这段问答？",
          message: "切回搜索会清掉当前的全部问答轮次，不能恢复。",
          confirmText: "丢弃并切回搜索",
          cancelText: "继续问",
        });
        if (!ok) return;
      }
      setMode(m);
      // 切回搜模式就丢掉整个会话：留着一堆答旧问题的轮次，比没有更让人困惑
      if (m === "search") {
        qaReset();
        setTakeover(false);
      }
    },
    [qaReset, hasQa],
  );

  /**
   * 发问 / 追问的统一入口。
   *
   * ✅ 宽屏**不再清掉选中笔记**（A-61 ① 带来的简化）。
   * 改之前必须清，因为第三栏是三元互斥的，不清的话回答被笔记盖着、
   * 用户按了回车什么也没看到；而那一清就会卸载 `NoteDetailPane`，
   * 所以又得先过一道未保存守卫。
   *
   * 现在笔记要么在下半（分栏）、要么被 `display: none` 盖着（窄栏），
   * **两种都不卸载** ⇒ 草稿安全 ⇒ 这条路径上也不再需要守卫。
   * 展开回答区就够了。
   */
  const handleAsk = useCallback(
    (q: string) => {
      // 折着的话先展开，否则用户按了回车只看到一个胶囊。
      if (hasDetailPane) setCollapsed(false);
      else setTakeover(true);
      void qaAsk(q);
    },
    [hasDetailPane, qaAsk, setCollapsed],
  );

  /** 胶囊 / 「回到回答」：把折起来（宽屏）/ 退回列表（窄屏）的回答叫回来。
   *  同样不再需要守卫与 `clearActive`，因此也不再是 async。 */
  const showQa = useCallback(() => {
    if (hasDetailPane) setCollapsed(false);
    else setTakeover(true);
  }, [hasDetailPane, setCollapsed]);

  /**
   * 点参考笔记：refs 只有 id/title，得先取回整条才能走 `openNote`（它需要 content）。
   *
   * 窄屏要先关掉问答面板：不关就是两层弹窗叠着。与宽屏「被盖但不销毁」
   * 同一语义：会话还在，胶囊也还在，点一下就回来。
   *
   * 宽屏下**什么都不用关**：这正是分栏要解的那个痛点——
   * 读到回答点参考笔记核对，而回答不消失。
   */
  const openRefNote = useCallback(
    async (noteId: string) => {
      if (!hasDetailPane) setTakeover(false);
      const n = await noteGet(noteId);
      // await：`openNote` 带守卫（换笔记会重挂载，可能要等用户回确认框）。
      if (n) await openNote(n);
    },
    [openNote, hasDetailPane],
  );

  return {
    qa,
    mode,
    question,
    setQuestion,
    enabled,
    takeover,
    setTakeover,
    inline,
    hasQa,
    barText,
    scopeLabel,
    handleMode,
    handleAsk,
    showQa,
    openRefNote,
    qaReset,
  };
}
