import { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDiff, type DiffMode } from "@/hooks/useDiff";
import { DiffPane } from "@/components/DiffPane";
import { relativeTime } from "@/lib/utils";
import type { HistoryItem } from "@/stores/appStore";
import styles from "./DiffDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";

interface DiffDialogProps {
  oldItem: HistoryItem;
  newItem: HistoryItem;
  onClose: () => void;
}

export function DiffDialog({ oldItem, newItem, onClose }: DiffDialogProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<DiffMode>("line");
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [currentBlock, setCurrentBlock] = useState(0);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  // U46：程序化跳转期间暂停双向滚动同步，避免同步逻辑打断平滑滚动
  const jumpingRef = useRef(false);

  const { left, right, added, removed, blockCount } = useDiff({
    oldText: oldItem.text || "",
    newText: newItem.text || "",
    mode,
    ignoreWhitespace: ignoreWs,
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
    // U46：用目标行的真实 DOM 位置定位（替代硬编码 20px 行高——按词模式下换行行高不固定），
    // 并同时平滑滚动左右两面板（此前仅滚左侧，右侧靠滚动同步追赶、观感生硬）
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

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "F7" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock + 1); }
      if (e.key === "F7" && e.shiftKey || (e.key === "ArrowUp" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, jumpTo, currentBlock]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, "success");
    } catch { toast("复制失败", "error"); }
  }, [toast]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={`dialog-box ${styles.diffDialog}`}
          onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              🔀 对比差异
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
                  className={`${styles.modeBtn}${mode === "line" ? ` ${styles.modeBtnActive}` : ""}`}
                  onClick={() => setMode("line")}
                >按行</button>
                <button
                  className={`${styles.modeBtn}${mode === "word" ? ` ${styles.modeBtnActive}` : ""}`}
                  onClick={() => setMode("word")}
                >按词</button>
              </div>
              <label className={styles.ignoreWs}>
                <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
                忽略空白
              </label>
            </div>
            <div className={styles.toolbarRight}>
              <button className={styles.navBtn} onClick={() => jumpTo(currentBlock - 1)}>
                <ChevronUp size={12} /> 上一处
              </button>
              <span className={styles.navInfo}>{blockCount > 0 ? `${currentBlock + 1} / ${blockCount}` : "0 / 0"}</span>
              <button className={styles.navBtn} onClick={() => jumpTo(currentBlock + 1)}>
                <ChevronDown size={12} /> 下一处
              </button>
            </div>
          </div>

          {/* Column headers */}
          <div className={styles.colHeaders}>
            <div className={styles.colHeader}>
              <span className={`${styles.colDot} ${styles.colDotOld}`} />
              旧文本 <span className={styles.colTime}>· {relativeTime(oldItem.time)} · {oldItem.source || "未知"}</span>
            </div>
            <div className={styles.colHeader}>
              <span className={`${styles.colDot} ${styles.colDotNew}`} />
              新文本 <span className={styles.colTime}>· {relativeTime(newItem.time)} · {newItem.source || "未知"}</span>
            </div>
          </div>

          {/* Diff body */}
          <div className={styles.diffBody}>
            <div ref={leftRef} style={{ overflow: "auto" }} onScroll={() => handleScroll("left")}>
              <DiffPane lines={left} currentBlock={currentBlock} />
            </div>
            <div ref={rightRef} style={{ overflow: "auto" }} onScroll={() => handleScroll("right")}>
              <DiffPane lines={right} currentBlock={currentBlock} />
            </div>
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            <div className={styles.footerLeft}>
              <button className={styles.actionBtn} onClick={() => handleCopy(oldItem.text || "", "旧文本")}>
                <Copy size={13} /> 复制旧文本
              </button>
              <button className={styles.actionBtn} onClick={() => handleCopy(newItem.text || "", "新文本")}>
                <Copy size={13} /> 复制新文本
              </button>
            </div>
            <button className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} onClick={onClose}>关闭</button>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
}
