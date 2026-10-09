import { primaryShortcutLabel } from "@/lib/utils";
import { useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HistoryItem } from "@/stores/appStore";
import { chipText } from "@/lib/stack/chipText";
import { getTypeIcon } from "@/lib/trayUtils";
import styles from "./StackBanner.module.css";

/** chip 高度（`.chip` 写死 28px）；轨道要有高度，否则绝对定位的子项把父容器撑不起来 */
const CHIP_H = 28;
/** chip 间距，与 `.queue` 原本的 `gap: 6px` 同值；虚拟化后由 virtualizer 的 `gap` 负责 */
const CHIP_GAP = 6;
/** 估宽（chip 上限 150px + 内容常远小于它）；估准一点能少掉几轮重测 */
const ESTIMATE_W = 118;
/** 无布局环境（jsdom / 首帧还没测到滚动容器宽度）下的兜底窗口长度 */
const FALLBACK_WINDOW = 40;
/** 队列长到多少条才摆「栈顶 / 栈底」跳转键（低于这个数滚动条本身就够用） */
const JUMP_MIN = 12;

type Cell =
  | { kind: "pending"; item: HistoryItem; idx: number }
  | { kind: "done"; item: HistoryItem };

type DragId = { current: string | null };

interface StackQueueProps {
  /** 未粘贴队列（index 0 = 下一个粘贴） */
  pendingItems: HistoryItem[];
  /** 本轮已粘贴（划线置灰、不可拖、无移除键） */
  doneItems: HistoryItem[];
  /** 「全部粘贴」进行中：禁用拖拽重排 */
  locked: boolean;
  onReorder: (fromId: string, toId: string) => void;
  onRemove: (id: string, text: string) => void;
  /** chip 全文悬浮卡（300ms 延时，portal 与定位都在父级） */
  hoverHandlers: (text: string) => {
    onMouseEnter: (e: MouseEvent<HTMLDivElement>) => void;
    onMouseLeave: () => void;
  };
}

/**
 * StackQueue — 栈横幅的队列行（窗口化渲染）。
 *
 * 为什么单独成文件、又为什么窗口化：栈容量默认从 50 提到 500 之后，父级照原样
 * `pendingItems.map` + `doneItems.map` 逐个渲染就是 500 颗带四个拖拽处理器 +
 * 移除键的 chip（约 8 个节点/颗）。辅助窗口关的是 `hide()` 不是 `close()`
 * （`docs/性能实现准则.md` §8.2），WebView 与 DOM 一直活着 —— 常驻元素数量由
 * 数组长度决定时，必须有个上限。
 *
 * 做法：待贴 + 已贴合成**一条**横向虚拟列表（`@tanstack/react-virtual`，与
 * CardList 同库同 `useFlushSync: false` 口径），只渲染视口内那几十颗。已贴项
 * 也进来是必要的：贴到 300 条时它自己就会把 DOM 又撑回去。
 *
 * ⚠️ 与旧的 flex + `gap` 布局有一处可见差别：`.chip:hover` 原本靠
 * `padding-left: 16px` 临时给拖拽手柄让位（省 500 颗的宽度）。虚拟化后必须改成
 * **常驻**预留（`.chipReserve`），因为悬停即变宽会让 `measureElement` 反复重测，
 * 表现为后面的 chip 集体抖一下。窗口化之后常驻只多花视口内几十颗的 6px。
 */
export function StackQueue({
  pendingItems,
  doneItems,
  locked,
  onReorder,
  onRemove,
  hoverHandlers,
}: StackQueueProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // P1 拖拽重排：dragId 存 id 而非下标（拖拽期间新内容入栈会让下标整体偏移，
  // 按下标取会拿到错的那条）；dragOverIdx 只为了画插入位指示线，必须触发重渲染。
  const dragId = useRef<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const cells = useMemo<Cell[]>(
    () => [
      ...pendingItems.map((item, idx) => ({ kind: "pending" as const, item, idx })),
      ...doneItems.map((item) => ({ kind: "done" as const, item })),
    ],
    [pendingItems, doneItems]
  );

  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => scrollRef.current,
    horizontal: true,
    estimateSize: () => ESTIMATE_W,
    gap: CHIP_GAP,
    overscan: 8,
    useFlushSync: false,
    getItemKey: (i) => {
      const c = cells[i];
      return c ? `${c.kind}:${c.item.id}` : i;
    },
  });

  // 测不到滚动容器宽度（jsdom、首帧）时不能交虚拟器：它给得出空窗口，
  // 现象是「整条队列一条都不显示」。退化成有界的前若干颗，走正常 flex 排版。
  const measurable = (virtualizer.scrollRect?.width ?? 0) > 0;
  const rows = measurable ? virtualizer.getVirtualItems() : [];
  const shownCells = measurable ? null : cells.slice(0, FALLBACK_WINDOW);
  const tail = pendingItems.length ? pendingItems[pendingItems.length - 1] : null;
  const showJump = cells.length > JUMP_MIN;

  const jump = useCallback(
    (to: "head" | "tail") => {
      virtualizer.scrollToIndex(to === "head" ? 0 : cells.length - 1, {
        align: to === "head" ? "start" : "end",
      });
    },
    // virtualizer 每次渲染都是新对象，但它包住的是同一份内部状态；
    // 真正会影响结果的是长度，所以依赖按 cells.length 收敛
    [cells.length, virtualizer]
  );

  const ctx: CellCtx = {
    locked,
    dragId,
    dragOverIdx,
    setDragOverIdx,
    onReorder,
    onRemove,
    hoverHandlers,
  };

  return (
    <div className={styles.queueRow}>
      {showJump && (
        <button
          type="button"
          className={styles.queueJump}
          title="回到栈顶（「下一个粘贴」在那儿）"
          onClick={() => jump("head")}
        >
          栈顶
        </button>
      )}
      <div className={styles.queue} ref={scrollRef}>
        {cells.length === 0 ? (
          <span className={styles.queueEmpty}>{`暂无收集 · 按 ${primaryShortcutLabel("c")} 开始`}</span>
        ) : (
          <div
            className={measurable ? styles.queueTrack : styles.queueTrackFlow}
            // ui-rule-ok: 轨道总宽与每颗 chip 的 left 都是虚拟器运行时算出的像素值，进不了 CSS
            style={measurable ? { width: virtualizer.getTotalSize(), height: CHIP_H } : undefined}
          >
            {measurable
              ? rows.map((vr) => {
                  const cell = cells[vr.index];
                  if (!cell) return null;
                  return (
                    <div
                      key={vr.key}
                      ref={virtualizer.measureElement}
                      data-index={vr.index}
                      className={styles.queueCell}
                      // ui-rule-ok: 虚拟器算出的像素偏移，进不了 CSS
                      style={{ left: vr.start, top: 0 }}
                    >
                      {renderCell(cell, ctx)}
                    </div>
                  );
                })
              : shownCells?.map((cell) => renderCell(cell, ctx, cell.item.id))}
          </div>
        )}
      </div>
      {showJump && (
        <button
          type="button"
          className={styles.queueJump}
          // 报出最旧一条的开头，免得跳过去之前完全不知道那儿是什么
          title={
            tail
              ? `共 ${cells.length} 条 · 栈底是「${chipText(tail).slice(0, 24)}」`
              : `共 ${cells.length} 条（本轮都贴过了）`
          }
          onClick={() => jump("tail")}
        >
          栈底 {cells.length}
        </button>
      )}
    </div>
  );
}

interface CellCtx {
  locked: boolean;
  dragId: DragId;
  dragOverIdx: number | null;
  setDragOverIdx: (v: number | null) => void;
  onReorder: (fromId: string, toId: string) => void;
  onRemove: (id: string, text: string) => void;
  hoverHandlers: StackQueueProps["hoverHandlers"];
}

/**
 * 一颗 chip（待贴或已贴）。
 *
 * 抽成函数而不是组件：虚拟窗口与兜底窗口要共用**同一份** DOM 结构，
 * 包成组件会让 chip 的 hover/drag 多一层无谓的 props 透传。
 * `key` 由调用处给（虚拟行的 key 是 `vr.key`，兜底是条目 id）。
 */
function renderCell(cell: Cell, ctx: CellCtx, key?: string): ReactNode {
  const { item } = cell;
  const pending = cell.kind === "pending";
  const idx = pending ? cell.idx : -1;
  const text = chipText(item);
  const dragging = pending && ctx.dragId.current === item.id;

  return (
    <div
      key={key}
      className={`${styles.chip}${pending ? ` ${styles.chipReserve}` : ""}${
        pending && idx === 0 ? ` ${styles.chipNext}` : ""
      }${pending ? "" : ` ${styles.chipDone}`}${dragging ? ` ${styles.dragging}` : ""}`}
      {...ctx.hoverHandlers(text)}
      draggable={pending && !ctx.locked}
      onDragStart={
        pending
          ? () => {
              ctx.dragId.current = item.id;
            }
          : undefined
      }
      onDragOver={
        pending
          ? (e) => {
              e.preventDefault();
              if (ctx.dragId.current !== null) ctx.setDragOverIdx(idx);
            }
          : undefined
      }
      onDrop={
        pending
          ? (e) => {
              e.preventDefault();
              if (ctx.dragId.current !== null && ctx.dragId.current !== item.id) {
                ctx.onReorder(ctx.dragId.current, item.id);
              }
              ctx.dragId.current = null;
              ctx.setDragOverIdx(null);
            }
          : undefined
      }
      onDragEnd={
        pending
          ? () => {
              ctx.dragId.current = null;
              ctx.setDragOverIdx(null);
            }
          : undefined
      }
    >
      {pending && ctx.dragOverIdx === idx && ctx.dragId.current !== item.id && (
        <span className={styles.insertSlot} />
      )}
      {pending && idx === 0 && <span className={styles.nextTag}>下一个粘贴</span>}
      {pending && (
        <span className={styles.grip} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span className={styles.ord}>{pending ? idx + 1 : "✓"}</span>
      <span className={styles.ico}>{getTypeIcon(item.type)}</span>
      <span className={styles.txt}>{text}</span>
      {pending && (
        <button
          className={styles.rm}
          title="从队列移除（不粘贴）"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onRemove(item.id, text);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
