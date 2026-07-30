/**
 * SequentialPasteDialog.tsx — 依次粘贴面板（收纳进工具箱，替代原主窗口常驻 FAB）。
 *
 * 队列 = 当前筛选下的文本记录（与热键 Ctrl+Alt+Q 粘贴用的同一数据源 getFilteredItems）。
 * 能力：进度可视（N/M + 进度条）、已粘贴项标绿、指针条高亮「下一条」、
 *       点任意行跳转指针、「粘贴当前」、「重置指针」。
 * 热键与 toast 反馈不变——不看面板也能连续粘贴。
 */
import { useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ClipboardList, RotateCcw } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { sequentialPaste } from "@/lib/api";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { formatHotkey } from "@/components/settings/HotkeyRecorder";
import styles from "./SequentialPasteDialog.module.css";

export function SequentialPasteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const anim = useDialogAnim();

  // 反应式订阅筛选相关字段，保证面板内队列与主列表筛选结果一致。
  // 注意：不能直接 select getFilteredItems() 的返回值（每次新数组引用 → 无限重渲染），
  // 故订阅原始字段、组件内 useMemo 派生（与 App.tsx seqTotal 同一模式）。
  const history = useAppStore((s) => s.history);
  const searchKeyword = useAppStore((s) => s.searchKeyword);
  const filterType = useAppStore((s) => s.filterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const workspace = useAppStore((s) => s.config.current_workspace);
  const getFilteredItems = useAppStore((s) => s.getFilteredItems);

  const seqPointer = useAppStore((s) => s.seqPointer);
  const setSeqPointer = useAppStore((s) => s.setSeqPointer);
  const resetSeqPointer = useAppStore((s) => s.resetSeqPointer);
  const loop = useAppStore((s) => s.config.sequential_loop);
  const hotkey = useAppStore((s) => s.config.sequential_hotkey);

  const textItems = useMemo(
    () => getFilteredItems().filter((h) => h.type === "text"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getFilteredItems, history, searchKeyword, filterType, timeFilter, sourceFilter, groupFilter, selectedTagIds, workspace]
  );

  const total = textItems.length;
  const done = Math.min(seqPointer, total);
  const percent = total > 0 ? (done / total) * 100 : 0;

  // 指针推进时把「下一条」滚动进可视区
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [seqPointer, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className="dialog-box w380"
              onClick={(e) => e.stopPropagation()}
              style={{ maxHeight: "76vh" }}
            >
              <div className="dialog-header">
                <h2 className="dialog-title">📋 依次粘贴</h2>
                <button onClick={onClose} className="dialog-close" aria-label="关闭"><X size={15} /></button>
              </div>

              {/* 进度区 */}
              <div className={styles.progress}>
                <div className={styles.progressTop}>
                  <span className={styles.progressLabel}>
                    当前筛选 · 共 {total} 条 · 进度 <b>{done} / {total}</b>
                  </span>
                  <span className={styles.loopChip}>{loop ? "🔁 循环开启" : "➡️ 到末尾停止"}</span>
                </div>
                <div className={styles.bar}><div className={styles.barFill} style={{ width: `${percent}%` }} /></div>
              </div>

              {/* 队列列表 */}
              <div className={styles.list}>
                {total === 0 ? (
                  <div className={styles.empty}>当前筛选下没有文本记录<br />切换筛选或先复制一些文本吧</div>
                ) : (
                  textItems.map((item, idx) => {
                    const isCurrent = idx === seqPointer;
                    const isDone = idx < seqPointer;
                    return (
                      <button
                        key={item.id}
                        ref={isCurrent ? currentRef : undefined}
                        className={`${styles.item}${isCurrent ? ` ${styles.itemCurrent}` : ""}${isDone ? ` ${styles.itemDone}` : ""}`}
                        onClick={() => setSeqPointer(idx)}
                        title="点击把指针跳到这一条"
                      >
                        <span className={styles.idx}>{idx + 1}</span>
                        <span className={styles.itemText}>{item.text || "(空文本)"}</span>
                        {isCurrent && <span className={styles.itemTag}>下一条</span>}
                        {isDone && <span className={styles.itemTag}>已粘贴</span>}
                      </button>
                    );
                  })
                )}
              </div>

              {/* 底栏 */}
              <div className={styles.footer}>
                <span className={styles.hotkey}>
                  <kbd>{formatHotkey(hotkey || "ctrl+alt+q")}</kbd> 快速粘贴
                </span>
                <span className={styles.actions}>
                  <button className={styles.btnReset} onClick={() => resetSeqPointer()} disabled={total === 0}>
                    <RotateCcw size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />重置指针
                  </button>
                  <button className={styles.btnPaste} onClick={() => sequentialPaste()} disabled={total === 0}>
                    <ClipboardList size={14} /> 粘贴当前
                  </button>
                </span>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
