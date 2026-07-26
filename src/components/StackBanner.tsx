import { memo, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Layers, X, Square } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import type { HistoryItem } from "@/stores/appStore";
import { stackPasteNext, stackPasteAll, abortStackPasteAll, exitStack } from "@/lib/api";
import { getTypeIcon } from "@/lib/trayUtils";
import { formatHotkey } from "@/components/settings/HotkeyRecorder";
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
        : "栈模式 · 等待收集";

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
                ⏩ 逐条粘贴 <kbd className={styles.kbd}>{pasteKey}</kbd>
              </button>
              <button
                className={styles.btn}
                onClick={() => stackPasteAll()}
                disabled={remaining === 0}
                title="连续粘贴剩余全部条目"
              >
                ▶ 全部
              </button>
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
              <div
                key={it.id}
                className={`${styles.chip}${i === 0 ? ` ${styles.chipNext}` : ""}`}
                title={chipText(it)}
              >
                {i === 0 && <span className={styles.nextTag}>下一个粘贴</span>}
                <span className={styles.ord}>{i + 1}</span>
                <span className={styles.ico}>{getTypeIcon(it.type)}</span>
                <span className={styles.txt}>{chipText(it)}</span>
              </div>
            ))}
            {doneItems.map((it) => (
              <div key={it.id} className={`${styles.chip} ${styles.chipDone}`} title={chipText(it)}>
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
    </AnimatePresence>
  );
});
