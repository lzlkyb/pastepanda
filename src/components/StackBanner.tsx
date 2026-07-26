import { memo, useEffect } from "react";
import { Layers, X, Square } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { stackPasteAll, abortStackPasteAll, exitStack } from "@/lib/api";
import styles from "./StackBanner.module.css";

/** 剪贴板栈横幅 — 栈模式激活时显示在卡片列表上方 */
export const StackBanner = memo(function StackBanner() {
  const stackMode = useAppStore((s) => s.stackMode);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackPasted = useAppStore((s) => s.stackPasted);
  const stackCollected = useAppStore((s) => s.stackCollected);
  const stackPasteAllActive = useAppStore((s) => s.stackPasteAllActive); // U58
  const config = useAppStore((s) => s.config);

  // U58：窗口聚焦时按 Esc 中止「全部粘贴」
  useEffect(() => {
    if (!stackPasteAllActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") abortStackPasteAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stackPasteAllActive]);

  if (!stackMode) return null;

  const remaining = stackItems.length;
  // 修复 Low：分母用真实收集总数（含被 50 上限截断丢弃的），避免进度虚高
  const total = Math.max(stackCollected, stackPasted + remaining);
  const pasteKey = config.stack_paste_hotkey || "ctrl+alt+p";
  const toggleKey = config.stack_toggle_hotkey || "ctrl+alt+k";
  // U58：全部粘贴进度百分比
  const progressPct = total > 0 ? Math.min(100, Math.round((stackPasted / total) * 100)) : 0;

  return (
    <div className={styles.banner}>
      <span className={styles.dot} />
      <div className={styles.text}>
        <div className={styles.title}>
          <Layers size={12} />
          {stackPasteAllActive
            ? `全部粘贴中 · ${stackPasted}/${total}`
            : `栈模式 · ${remaining > 0 ? `剩余 ${remaining} 条` : "等待收集"}`}
        </div>
        <div className={styles.sub}>
          {stackPasteAllActive
            ? `再按 ${pasteKey} 或 Esc 中止`
            : `${stackPasted > 0 ? `已粘贴 ${stackPasted}/${total} · ` : ""}Ctrl+C 收集 · ${pasteKey} 逐条粘贴`}
        </div>
        {/* 进度条：常驻显示已粘贴/总数进度 */}
        {total > 0 && (
          <div className={styles.progressTrack} role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
            <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>
      {stackPasteAllActive ? (
        <button className={styles.abortBtn} onClick={() => abortStackPasteAll()} title={`中止全部粘贴 (${pasteKey} / Esc)`}>
          <Square size={10} /> 中止
        </button>
      ) : (
        remaining > 0 && (
          <button className={styles.pasteAllBtn} onClick={() => stackPasteAll()} title="连续粘贴剩余全部条目">
            ▶ 全部粘贴
          </button>
        )
      )}
      <button className={styles.exitBtn} onClick={() => exitStack()} title={`退出栈模式 (${toggleKey})`}>
        <X size={12} /> 退出
      </button>
    </div>
  );
});
