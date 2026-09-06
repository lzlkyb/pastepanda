import { useState, useCallback, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Copy, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useDiff, type DiffMode } from "@/hooks/useDiff";
import { DiffPane } from "@/components/DiffPane";
import { DiffAiMenu } from "@/components/DiffAiMenu";
import { useDiffAi, type DiffSide, DIFF_AI_ACTIONS } from "@/hooks/useDiffAi";
import { relativeTime } from "@/lib/utils";
import type { HistoryItem } from "@/stores/appStore";
import styles from "./DiffDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogEscape } from "@/hooks/useDialogEscape";

interface DiffDialogProps {
  /** 历史对比模式：两条 HistoryItem */
  oldItem?: HistoryItem;
  newItem?: HistoryItem;
  /** 自由编辑模式：预填的纯文本（独立入口用） */
  initialLeft?: string;
  initialRight?: string;
  freeMode?: boolean;
  /** 深编入口：把当前左/右两侧文本送入独立全屏窗口继续对比 */
  onOpenFullscreen?: (left: string, right: string) => void;
  onClose: () => void;
}

export function DiffDialog({ oldItem, newItem, initialLeft, initialRight, freeMode, onClose, onOpenFullscreen }: DiffDialogProps) {
  const { toast } = useToast();
  const anim = useDialogAnim();
  const [mode, setMode] = useState<DiffMode>("line");
  const [viewMode, setViewMode] = useState<"preview" | "edit">(freeMode ? "edit" : "preview");
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [leftText, setLeftText] = useState(freeMode ? (initialLeft ?? "") : (oldItem?.text ?? ""));
  const [rightText, setRightText] = useState(freeMode ? (initialRight ?? "") : (newItem?.text ?? ""));
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [aiTargetSide, setAiTargetSide] = useState<DiffSide>("left");
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  // U46：程序化跳转期间暂停双向滚动同步，避免同步逻辑打断平滑滚动
  const jumpingRef = useRef(false);

  const { left, right, added, removed, blockCount } = useDiff({
    oldText: leftText,
    newText: rightText,
    mode,
    ignoreWhitespace: ignoreWs,
  });

  const { aiOk, runningId, run } = useDiffAi({
    leftText,
    rightText,
    onResult: (side, text) => {
      if (side === "left") setLeftText(text);
      else setRightText(text);
      setViewMode("preview");
      setCurrentBlock(0);
    },
    toast,
  });

  // 同步滚动
  const handleScroll = useCallback((source: "left" | "right") => {
    if (syncing.current || jumpingRef.current) return;
    syncing.current = true;
    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (from && to) {
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
    }
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  // 跳转到指定差异块
  const jumpTo = useCallback((block: number) => {
    const clamped = Math.max(0, Math.min(block, blockCount - 1));
    setCurrentBlock(clamped);
    const idx = left.findIndex((l) => l.diffBlock === clamped && l.state !== "unchanged" && l.state !== "empty");
    if (idx < 0) return;
    const from = leftRef.current;
    if (!from) return;
    const lineEl = from.firstElementChild?.children[idx] as HTMLElement | undefined;
    if (!lineEl) return;
    const top = Math.max(0, lineEl.getBoundingClientRect().top - from.getBoundingClientRect().top + from.scrollTop - 60);
    jumpingRef.current = true;
    from.scrollTo({ top, behavior: "smooth" });
    rightRef.current?.scrollTo({ top, behavior: "smooth" });
    window.setTimeout(() => { jumpingRef.current = false; }, 500);
  }, [blockCount, left]);

  // Esc 单独走公共 hook（捕获期 + stopPropagation）：原先它和下面的 F7 导航
  // 混在同一个冒泡监听里，不阻断，App 的 Esc 链会跟着隐藏主窗口。
  useDialogEscape(onClose);

  // 键盘快捷键（差异块跳转）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewMode !== "preview") return;
      if (e.key === "F7" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock + 1); }
      if (e.key === "F7" && e.shiftKey || (e.key === "ArrowUp" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, jumpTo, currentBlock, viewMode]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, "success");
    } catch { toast("复制失败", "error"); }
  }, [toast]);

  const pickAi = (actionId: string) => {
    const action = DIFF_AI_ACTIONS.find((a) => a.id === actionId);
    if (!action) return;
    void run(action, aiTargetSide);
    setAiMenuOpen(false);
  };

  const leftLabel = freeMode ? "左侧文本" : "旧文本";
  const rightLabel = freeMode ? "右侧文本" : "新文本";

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box ${styles.diffDialog}`}
        onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              🔀 {freeMode ? "文本对比" : "对比差异"}
              <span className={styles.stats}>
                <span className={styles.statAdd}>+{added}</span>
                <span className={styles.statDel}>-{removed}</span>
              </span>
            </h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Toolbar */}
          <div className={styles.toolbar}>
            <div className={styles.toolbarLeft}>
              <div className={styles.modeToggle}>
                <button
                  className={`${styles.modeBtn}${viewMode === "preview" ? ` ${styles.modeBtnActive}` : ""}`}
                  onClick={() => setViewMode("preview")}
                >预览</button>
                <button
                  className={`${styles.modeBtn}${viewMode === "edit" ? ` ${styles.modeBtnActive}` : ""}`}
                  onClick={() => setViewMode("edit")}
                >编辑</button>
              </div>
              {viewMode === "preview" && (
                <>
                  <div className={styles.modeToggle}>
                    <button className={`${styles.modeBtn}${mode === "line" ? ` ${styles.modeBtnActive}` : ""}`} onClick={() => setMode("line")}>按行</button>
                    <button className={`${styles.modeBtn}${mode === "word" ? ` ${styles.modeBtnActive}` : ""}`} onClick={() => setMode("word")}>按词</button>
                  </div>
                  <label className={styles.ignoreWs}>
                    <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
                    忽略空白
                  </label>
                </>
              )}
            </div>
            <div className={styles.toolbarRight}>
              {aiOk && (
                <div className={styles.aiWrap}>
                  <button className={`${styles.navBtn} ${styles.aiBtn}`} onClick={() => setAiMenuOpen((v) => !v)} disabled={runningId !== null}>
                    ✦ AI
                  </button>
                  <DiffAiMenu
                    open={aiMenuOpen}
                    targetSide={aiTargetSide}
                    setTargetSide={setAiTargetSide}
                    onPick={pickAi}
                    runningId={runningId}
                    onClose={() => setAiMenuOpen(false)}
                  />
                </div>
              )}
              {viewMode === "preview" && (
                <>
                  <button className={styles.navBtn} onClick={() => jumpTo(currentBlock - 1)}>
                    <ChevronUp size={12} /> 上一处
                  </button>
                  <span className={styles.navInfo}>{blockCount > 0 ? `${currentBlock + 1} / ${blockCount}` : "0 / 0"}</span>
                  <button className={styles.navBtn} onClick={() => jumpTo(currentBlock + 1)}>
                    <ChevronDown size={12} /> 下一处
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Column headers */}
          <div className={styles.colHeaders}>
            <div className={styles.colHeader}>
              <span className={`${styles.colDot} ${styles.colDotOld}`} />
              {leftLabel}
              {!freeMode && oldItem && (
                <span className={styles.colTime}>· {relativeTime(oldItem.time)} · {oldItem.source || "未知"}</span>
              )}
            </div>
            <div className={styles.colHeader}>
              <span className={`${styles.colDot} ${styles.colDotNew}`} />
              {rightLabel}
              {!freeMode && newItem && (
                <span className={styles.colTime}>· {relativeTime(newItem.time)} · {newItem.source || "未知"}</span>
              )}
            </div>
          </div>

          {/* Diff body / Edit body */}
          {viewMode === "preview" ? (
            <div className={styles.diffBody}>
              <div ref={leftRef} style={{ overflow: "auto" }} onScroll={() => handleScroll("left")}>
                <DiffPane lines={left} currentBlock={currentBlock} />
              </div>
              <div ref={rightRef} style={{ overflow: "auto" }} onScroll={() => handleScroll("right")}>
                <DiffPane lines={right} currentBlock={currentBlock} />
              </div>
            </div>
          ) : (
            <div className={styles.editBody}>
              <textarea
                className={styles.editArea}
                value={leftText}
                onChange={(e) => setLeftText(e.target.value)}
                placeholder="左侧文本（旧）"
                spellCheck={false}
              />
              <textarea
                className={styles.editArea}
                value={rightText}
                onChange={(e) => setRightText(e.target.value)}
                placeholder="右侧文本（新）"
                spellCheck={false}
              />
            </div>
          )}

          {/* Footer */}
          <div className={styles.footer}>
            <div className={styles.footerLeft}>
              {onOpenFullscreen && (
                <button className={styles.actionBtn} onClick={() => onOpenFullscreen(leftText, rightText)} title="在新窗口深编对比">
                  ⤢ 全屏深编
                </button>
              )}
              <button className={styles.actionBtn} onClick={() => handleCopy(leftText, leftLabel)}>
                <Copy size={13} /> 复制{leftLabel}
              </button>
              <button className={styles.actionBtn} onClick={() => handleCopy(rightText, rightLabel)}>
                <Copy size={13} /> 复制{rightLabel}
              </button>
            </div>
            <button className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} onClick={onClose}>关闭</button>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
  );
}
