/**
 * KbThirdPane — 第三栏的容器与归属规则（A-61 ①）。
 *
 * 为何需要它：改之前第三栏是三元互斥的
 * （`activeNote ? 笔记 : 问答中 ? 问答 : 空态`），于是**问答与笔记在抢同一栏**：
 * 读到回答想点参考笔记核对 → 回答消失；想回到回答 → 笔记消失。
 * 「边看回答边核对来源」在那个布局里做不到。
 * （中栏那条「已回答 N 轮」状态条就是这个零和设计的补丁——
 * 一个功能需要专门的「它还在」提示条，说明它本不该消失。）
 *
 * 四种态：
 * | 能分栏 | 问答折叠 | 开着笔记 | 渲染 |
 * |---|---|---|---|
 * | 是 | 否 | — | **上下分栏**：回答在上、笔记在下、中间可拖 |
 * | 是 | 是 | — | 顶部一行胶囊 + 笔记占满 |
 * | 否 | 否 | 否 | 回答占满（笔记那边本来就是空态） |
 * | 否 | 其它 | — | 顶部胶囊 + 笔记占满 |
 *
 * 🔴 两个面板**都不卸载**，只用 `display: none` 隐：
 *   - 笔记那边带 `key={note.id}`，卸载就重建 CodeMirror，**未保存草稿会静默消失**
 *   - 问答那边的追问框是本地 state，卸载就丢刚敲的追问
 *
 * ❗ 能不能分栏靠 `ResizeObserver` 量**本容器**，不看 `window.innerWidth`：
 *   侧栏能收起，收起后同一窗口宽下第三栏会宽 180px（同 `NoteDetailPane`
 *   量 pane 宽度定分屏的做法）。而且上下分栏真正的约束是**高度**，
 *   那个根本不在宽度断点里。
 *
 * ❗ 但量出来的 `canSplit` **住在 `KnowledgeView`**（靠 `useCanSplitPane` + 它持有的 ref），
 *   不在本组件里：发问与点笔记那两条路径都要根据能不能分栏做不同的事，
 *   而它们在上层。放在本组件里再上报就成了「子组件量 → 父组件存 → 传回子组件」
 *   的环形数据流。
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Sparkles, ChevronRight } from "lucide-react";
import styles from "./KbThirdPane.module.css";
import { useSplitDrag } from "@/hooks/useSplitDrag";

/**
 * 分栏后回答区至少多高。
 *
 * 原为 120——但问答区不只有正文：头部标题行 + 底部「当前范围 + 追问框」
 * 都是 `flex-shrink: 0`，减完答案区只剩约 40px，实际不可读。
 * 180 保证「标题 + 至少 3 行答案 + 输入行」都在（2026-09-06）。
 */
const MIN_QA_PX = 180;
/** 笔记区至少多高。比回答区大：它里面是标题行 + 形态切换器 + 编辑区。 */
const MIN_MAIN_PX = 160;
/** 拖手柄的高（与 CSS 里的 `.grip` 保持一致）。 */
const GRIP_PX = 7;

/**
 * 能分栏的最小容器高度。
 *
 * 两个下限 + 手柄 = 180 + 160 + 7 = 347px，再加上两边各自的标题行与内边距——
 * 低于 480 时两块都只剩一行半，分不如不分（改走折叠切换）。
 *
 * ❗ 跟着 `MIN_QA_PX` 120→180 一起从 420 抬到 480：不抬的话 420px 容器里
 *   两块全压在各自下限上，分栏形同虚设（原注释里的 287 是旧值）。
 */
const MIN_SPLIT_H = 480;
/**
 * 能分栏的最小容器宽度。
 *
 * 800px 窗口（侧栏开着）时第三栏只有 ~315px：那么窄的一栏再切两段，
 * 两块都得挤着读。420 是「两块各自能放下一行中文」的下限。
 */
const MIN_SPLIT_W = 420;

/** 分栏比例的持久化 key。布局偏好持久化，与三形态切换器同口径。 */
const RATIO_KEY = "pastepanda_kb_split_ratio";
/** 回答区默认占 44%：回答高度基本固定，笔记可能很长且要滚，给它多一点。 */
const DEFAULT_RATIO = 44;

// 读取/写入比例的那段已移到 `useSplitDrag`（2026-09-06），这里不再自己读写。

/**
 * 第三栏能不能上下分栏。
 *
 * 导出给 `KnowledgeView` 用（ref 由它持有并传给 `KbThirdPane`）：
 * 发问与点笔记那两条路径要根据它做不同的事，而那两条在上层。
 */
export function useCanSplitPane(ref: RefObject<HTMLElement | null>): boolean {
  const [canSplit, setCanSplit] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanSplit(el.clientHeight >= MIN_SPLIT_H && el.clientWidth >= MIN_SPLIT_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return canSplit;
}

export interface KbThirdPaneProps {
  /** 上半：问答面板。`null` = 没会话（此时笔记占整栏，与改之前一样）。 */
  qa: ReactNode | null;
  /** 下半：笔记详情或空态。**总是有**。 */
  main: ReactNode;
  /** 本容器的 ref。由 `KnowledgeView` 持有，它靠它量 `canSplit`。 */
  paneRef: RefObject<HTMLDivElement | null>;
  /** 能不能上下分栏（`useCanSplitPane` 的结果）。 */
  canSplit: boolean;
  /** 问答区被折叠了。 */
  qaCollapsed: boolean;
  onToggleQaCollapsed: () => void;
  /** 胶囊上的摘要（形如「已回答 2 轮 · 参考 3 篇」）。 */
  qaBarText: string;
}

export function KbThirdPane({
  qa,
  main,
  paneRef,
  canSplit,
  qaCollapsed,
  onToggleQaCollapsed,
  qaBarText,
}: KbThirdPaneProps) {
  // 拖拽、下限夹算、持久化全走共用 hook（规则 #11）。
  // 2026-09-06 从本文件抽出去的：中栏↔第三栏 那个横向分栏需要一模一样的逻辑，
  // 再抄一份就是第二份真相。
  const { ratio, onGripDown } = useSplitDrag({
    axis: "y",
    containerRef: paneRef,
    minFirstPx: MIN_QA_PX,
    minSecondPx: MIN_MAIN_PX,
    gripPx: GRIP_PX,
    storageKey: RATIO_KEY,
    defaultRatio: DEFAULT_RATIO,
  });

  const hasQa = qa !== null;
  /** 真的在上下分栏。 */
  const split = hasQa && canSplit && !qaCollapsed;
  /**
   * 回答占整栏（改之前的行为）：窄到不能分栏、且未折叠。
   *
   * 口径统一成**未折叠 = 回答在眼前，折叠 = 胶囊 + 笔记**，
   * 而不再看「有没有开着笔记」——那个判断会造出一个坏态：
   * 窄栏下发问后又点了一条笔记，两边都不占整栏，只剩一个胶囊。
   * “点笔记时自动折叠”由上层在 `handleOpen` 里做（它才知道 canSplit）。
   */
  const qaFull = hasQa && !canSplit && !qaCollapsed;
  /** 胶囊：有会话但回答没在眼前。它是「回答还在」的唯一凭据与入口。 */
  const showBar = hasQa && !split && !qaFull;


  return (
    <div className={styles.third} ref={paneRef}>
      {/* 胶囊。从中栏搬到这里（A-61 ①）：它指向的东西在第三栏，
          放在中栏是指错了地方。窄屏（没第三栏）那一条仍留在中栏。 */}
      {showBar && (
        <button type="button" className={styles.bar} onClick={onToggleQaCollapsed}>
          <Sparkles size={11} />
          <span className={styles.barText}>{qaBarText}</span>
          <ChevronRight size={12} className={styles.barArrow} />
        </button>
      )}

      {/* 🔴 两个 slot 都常挂载，只用 `display` 隐（详见文件头红线）。
          `display` 写在行内而不用 `hidden` 属性：`.slot` 带 `display: flex`，
          会把 `hidden` 的默认 `display: none` 盖掉。 */}
      {hasQa && (
        <div
          className={styles.slot}
          style={{
            display: split || qaFull ? "flex" : "none",
            // 分栏时按比例；占整栏时吃满
            flex: split ? `0 0 ${ratio}%` : "1 1 auto",
          }}
        >
          {qa}
        </div>
      )}

      {split && (
        <div
          className={styles.grip}
          onMouseDown={onGripDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整回答与笔记的高度"
        />
      )}

      <div
        className={styles.slot}
        style={{ display: qaFull ? "none" : "flex", flex: "1 1 auto" }}
      >
        {main}
      </div>
    </div>
  );
}
