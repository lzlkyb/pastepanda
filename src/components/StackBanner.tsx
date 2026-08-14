import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Layers, X, Square } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import type { HistoryItem } from "@/stores/appStore";
import { stackPasteNext, stackPasteAll, abortStackPasteAll, exitStack } from "@/lib/api";
import { getTypeIcon } from "@/lib/trayUtils";
import { useToast } from "@/components/Toast";
import { formatHotkey } from "@/components/settings/HotkeyRecorder";
import { stackItemsToMergeItems } from "@/lib/mergeText";
import { MergeDialog } from "@/components/MergeDialog";
import { SaveTemplateDialog, TemplateLibraryDialog } from "@/components/StackTemplateDialog";
import styles from "./StackBanner.module.css";

/** 紧凑热键标签：复用 formatHotkey 的大小写映射，去掉空格适配窄按钮（ctrl+alt+p → Ctrl+Alt+P） */
function compactHotkey(combo: string): string {
  return formatHotkey(combo).replace(/\s+/g, "");
}

/** chip 显示文本：优先 text，空时按类型回退（图片/文件可能无文本摘要） */
function chipText(it: HistoryItem): string {
  const t = it.text?.trim();
  if (t) return t;
  return it.type === "image" ? "图片" : it.type === "file" ? "文件" : "(空)";
}

/**
 * 剪贴板栈横幅 — 栈模式激活时显示在卡片列表上方（滚动区外的固定节点）。
 * 方案 A「横幅内嵌队列」：纵向三层结构 —— 状态行 / 队列 chips 行 / 进度行。
 * 队列按粘贴顺序排列（左 → 右 = 先粘贴），当前项高亮并挂「下一个粘贴」标签，
 * 已粘贴项划线置灰留在队尾（从 history 按 id 反查文本）。
 */
export const StackBanner = memo(function StackBanner() {
  const stackMode = useAppStore((s) => s.stackMode);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackDoneIds = useAppStore((s) => s.stackDoneIds);
  const stackPasted = useAppStore((s) => s.stackPasted);
  const stackCollected = useAppStore((s) => s.stackCollected);
  const stackPasteAllActive = useAppStore((s) => s.stackPasteAllActive); // U58
  const config = useAppStore((s) => s.config);
  const history = useAppStore((s) => s.history);
  const stackReorder = useAppStore((s) => s.stackReorder);
  const stackRemoveItem = useAppStore((s) => s.stackRemoveItem);
  const stackTabAdvance = useAppStore((s) => s.stackTabAdvance);
  const toggleStackTabAdvance = useAppStore((s) => s.toggleStackTabAdvance);
  const stackLastSplit = useAppStore((s) => s.stackLastSplit);
  const stackUndoSplit = useAppStore((s) => s.stackUndoSplit);
  const stackConsumeMerged = useAppStore((s) => s.stackConsumeMerged);
  const { toast } = useToast();

  // P1 拖拽重排：dragId 存的是拖拽发起时那一条的 id（而不是下标）——拖拽期间若有新内容入栈导致数组下标整体偏移，
  // 按 id 取仍能准确定位到同一条，改用下标会拿到错的那条去重排；
  // dragOverIdx 用 state 只为了画插入位指示线，必须触发重渲染
  const dragId = useRef<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // chip 内容预览：用自定义悬浮卡替代原生 title（后者延迟高、样式不可控）；hover 300ms 后展示全文。
  // portal 到 body + fixed 定位（同 12 行下 DeepCleanDialog 的 srcPopup 同款做法）：
  // .queue 有 overflow-x:auto，根据 CSS 规范会把未显式设置的 overflow-y 计算为 auto，
  // 否则向上浮出的卡片会被自己所在的滚动容器裁剪，直接 position:absolute 会看不全甚至看不见。
  const [hoverPreview, setHoverPreview] = useState<{ text: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  useEffect(() => clearHoverTimer, []);
  const chipHoverHandlers = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(() => setHoverPreview({ text, rect }), 300);
    },
    onMouseLeave: () => {
      clearHoverTimer();
      setHoverPreview(null);
    },
  });
  // 默认在 chip 上方展开，上方空间不够（例如第一行紧贴顶栏）时翻转到下方，同步把箭头方向也改过去
  useLayoutEffect(() => {
    if (!hoverPreview) return;
    const el = hoverCardRef.current;
    if (!el) return;
    const margin = 8;
    const gap = 8;
    const { rect } = hoverPreview;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
    let top = rect.top - gap - h;
    let flip = false;
    if (top < margin) {
      top = rect.bottom + gap;
      flip = true;
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.dataset.flip = flip ? "down" : "up";
  }, [hoverPreview]);
  // P2 合并粘贴：复用现有 MergeDialog，不新建同名组件
  const [showMerge, setShowMerge] = useState(false);
  // P4 模板栈：存为模板 / 模板库弹窗
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false);
  // 状态行不再永远展开 5按钮，低频操作收进「⋯」菜单
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showOverflow) return;
    const onClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [showOverflow]);

  // U58：窗口聚焦时按 Esc 中止「全部粘贴」
  useEffect(() => {
    if (!stackPasteAllActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") abortStackPasteAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stackPasteAllActive]);

  // 已粘贴 chips：stackDoneIds 仅存 id，需从 history 反查文本。
  // Set 保留插入顺序 → 即粘贴先后顺序。派生状态用 useMemo（Zustand 选择器不返回新引用）。
  const doneItems = useMemo(() => {
    if (stackDoneIds.size === 0) return [];
    const byId = new Map(history.map((h) => [h.id, h]));
    return [...stackDoneIds]
      .map((id) => byId.get(id))
      .filter((it): it is HistoryItem => Boolean(it));
  }, [history, stackDoneIds]);

  const remaining = stackItems.length;
  // 分母用真实收集总数（含被 50 上限截断丢弃的），避免进度虚高
  const total = Math.max(stackCollected, stackPasted + remaining);
  const progressPct = total > 0 ? Math.min(100, Math.round((stackPasted / total) * 100)) : 0;
  const pasteKey = compactHotkey(config.stack_paste_hotkey || "ctrl+alt+p");
  const toggleKey = formatHotkey(config.stack_toggle_hotkey || "ctrl+alt+k");
  const allDone = remaining === 0 && total > 0;

  const title = stackPasteAllActive
    ? `全部粘贴中 · ${stackPasted}/${total}`
    : allDone
      ? `栈模式 · 已全部粘贴完成（${total} 条）`
      : remaining > 0
        ? `栈模式 · 剩余 ${remaining} 条`
        : "栈模式";

  return (
    <AnimatePresence>
      {stackMode && (
        <motion.div
          className={styles.banner}
          exit={{
            opacity: 0,
            height: 0,
            paddingTop: 0,
            paddingBottom: 0,
            marginBottom: 0,
            overflow: "hidden",
            transition: { duration: 0.2, ease: "easeIn" },
          }}
        >
      {/* 状态行 */}
      <div className={styles.top}>
        <span className={styles.dot} />
        <div className={styles.title}>
          <Layers size={12} />
          {title}
        </div>
        <div className={styles.acts}>
          {stackPasteAllActive ? (
            <button
              className={styles.abortBtn}
              onClick={() => abortStackPasteAll()}
              title={`中止全部粘贴 (${pasteKey} / Esc)`}
            >
              <Square size={10} /> 中止
            </button>
          ) : (
            <>
              <button
                className={styles.primaryBtn}
                onClick={() => stackPasteNext()}
                disabled={remaining === 0}
                title={`粘贴栈顶条目 (${pasteKey})`}
              >
                {stackTabAdvance ? "⏩ 粘贴+Tab" : "⏩ 逐条粘贴"} <kbd className={styles.kbd}>{pasteKey}</kbd>
              </button>
              <button
                className={styles.btn}
                onClick={() => stackPasteAll()}
                disabled={remaining === 0}
                title={stackTabAdvance ? "连续粘贴剩余全部条目（每条都会自动 Tab 推进）" : "连续粘贴剩余全部条目"}
              >
                {stackTabAdvance ? "▶ 全部+Tab" : "▶ 全部"}
              </button>
              <div className={styles.overflowWrap} ref={overflowRef}>
                <button
                  className={styles.ghostBtn}
                  onClick={() => setShowOverflow((v) => !v)}
                  title="更多操作：合并粘贴 / Tab 推进 / 存为模板 / 模板库"
                >
                  ⋯
                </button>
                {showOverflow && (
                  <div className={styles.overflowMenu}>
                    <button
                      className={styles.overflowItem}
                      disabled={!stackLastSplit}
                      title="把最近一次表格拆分的行合并回一条原始整表文本"
                      onClick={() => {
                        stackUndoSplit();
                        setShowOverflow(false);
                        toast("已撤销拆分，还原为一条原文", "success");
                      }}
                    >
                      📐 撤销拆分
                    </button>
                    <div className={styles.overflowDivider} />
                    <button
                      className={styles.overflowItem}
                      disabled={remaining === 0}
                      onClick={() => { setShowMerge(true); setShowOverflow(false); }}
                    >
                      🧩 合并粘贴
                    </button>
                    <button
                      className={styles.overflowItem}
                      onClick={() => { toggleStackTabAdvance(); setShowOverflow(false); }}
                    >
                      {stackTabAdvance ? "⇥ 关闭 Tab 推进" : "⇥ 开启 Tab 推进"}
                    </button>
                    <button
                      className={styles.overflowItem}
                      disabled={remaining === 0}
                      onClick={() => { setShowSaveTemplate(true); setShowOverflow(false); }}
                    >
                      📌 存为模板
                    </button>
                    <button
                      className={styles.overflowItem}
                      onClick={() => { setShowTemplateLibrary(true); setShowOverflow(false); }}
                    >
                      📚 模板库
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          <button className={styles.ghostBtn} onClick={() => exitStack()} title={`退出栈模式 (${toggleKey})`}>
            <X size={12} />
          </button>
        </div>
      </div>

      {/* 队列行：按粘贴顺序排列，左 = 先粘贴 */}
      <div className={styles.queue}>
        {stackItems.length === 0 && doneItems.length === 0 ? (
          <span className={styles.queueEmpty}>暂无收集 · 按 Ctrl+C 开始</span>
        ) : (
          <>
            {stackItems.map((it, i) => (
              <Fragment key={it.id}>
                {dragOverIdx === i && dragId.current !== null && dragId.current !== it.id && (
                  <span className={styles.insertSlot} />
                )}
                <div
                  className={`${styles.chip}${i === 0 ? ` ${styles.chipNext}` : ""}${dragId.current === it.id ? ` ${styles.dragging}` : ""}`}
                  {...chipHoverHandlers(chipText(it))}
                  draggable={!stackPasteAllActive}
                  onDragStart={() => { dragId.current = it.id; }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragId.current !== null) setDragOverIdx(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId.current !== null && dragId.current !== it.id) stackReorder(dragId.current, it.id);
                    dragId.current = null;
                    setDragOverIdx(null);
                  }}
                  onDragEnd={() => {
                    dragId.current = null;
                    setDragOverIdx(null);
                  }}
                >
                  {i === 0 && <span className={styles.nextTag}>下一个粘贴</span>}
                  <span className={styles.grip} aria-hidden="true"><i /><i /><i /></span>
                  <span className={styles.ord}>{i + 1}</span>
                  <span className={styles.ico}>{getTypeIcon(it.type)}</span>
                  <span className={styles.txt}>{chipText(it)}</span>
                  <button
                    className={styles.rm}
                    title="从队列移除（不粘贴）"
                    onClick={(e) => {
                      e.stopPropagation();
                      stackRemoveItem(it.id);
                      toast("已从队列移除", "info");
                    }}
                  >
                    ✕
                  </button>
                </div>
              </Fragment>
            ))}
            {doneItems.map((it) => (
              <div key={it.id} className={`${styles.chip} ${styles.chipDone}`} {...chipHoverHandlers(chipText(it))}>
                <span className={styles.ord}>✓</span>
                <span className={styles.ico}>{getTypeIcon(it.type)}</span>
                <span className={styles.txt}>{chipText(it)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 进度行 */}
      <div className={styles.foot}>
        <div
          className={styles.prog}
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.progFill} style={{ width: `${progressPct}%` }} />
        </div>
        <span className={styles.footTxt}>
          {stackPasted}/{total} 已粘贴 · Ctrl+C 继续收集
        </span>
      </div>
        </motion.div>
      )}
      {hoverPreview && createPortal(
        <div ref={hoverCardRef} className={styles.hoverCard}>
          <div className={styles.hcLabel}>完整内容</div>
          {hoverPreview.text}
        </div>,
        document.body,
      )}
      {showMerge && (
        <MergeDialog
          items={stackItemsToMergeItems(stackItems)}
          onClose={() => setShowMerge(false)}
          onPasted={(ids) => stackConsumeMerged(ids)}
        />
      )}
      {showSaveTemplate && (
        <SaveTemplateDialog items={stackItems} onClose={() => setShowSaveTemplate(false)} />
      )}
      {showTemplateLibrary && (
        <TemplateLibraryDialog onClose={() => setShowTemplateLibrary(false)} />
      )}
    </AnimatePresence>
  );
});
