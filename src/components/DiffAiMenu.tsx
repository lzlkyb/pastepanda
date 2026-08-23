import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { DIFF_AI_ACTIONS, type DiffSide } from "@/hooks/useDiffAi";
import styles from "./DiffDialog.module.css";

/**
 * diff 编辑器 AI 下拉菜单（浮层）。
 * 选「目标侧」决定 AI 处理哪一侧文本，结果由调用方写回对侧并切预览。
 * 仅 aiOk 为真时由父组件渲染本菜单（未启用 AI 整条不出现）。
 */
export function DiffAiMenu({ open, targetSide, setTargetSide, onPick, runningId, onClose }: {
  open: boolean;
  targetSide: DiffSide;
  setTargetSide: (s: DiffSide) => void;
  onPick: (actionId: string) => void;
  runningId: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(`.${styles.aiMenu}`) || t.closest(`.${styles.aiBtn}`)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className={styles.aiMenuBackdrop} onClick={onClose} />
      <div className={styles.aiMenu} role="menu">
        <div className={styles.aiMenuTitle}>✦ AI 处理</div>
        <div className={styles.aiMenuSide}>
          <span className={styles.aiMenuSideLabel}>目标侧</span>
          <div className={styles.aiSideSeg}>
            <button
              className={`${styles.aiSideBtn}${targetSide === "left" ? ` ${styles.aiSideActive}` : ""}`}
              onClick={() => setTargetSide("left")}
            >左侧</button>
            <button
              className={`${styles.aiSideBtn}${targetSide === "right" ? ` ${styles.aiSideActive}` : ""}`}
              onClick={() => setTargetSide("right")}
            >右侧</button>
          </div>
        </div>
        <div className={styles.aiMenuList}>
          {DIFF_AI_ACTIONS.map((a) => (
            <button
              key={a.id}
              className={styles.aiMenuItem}
              disabled={runningId !== null}
              onClick={() => onPick(a.id)}
            >
              <Sparkles size={13} />
              <span>{a.label}</span>
              {runningId === a.id && <span className={styles.aiMenuBusy}>…</span>}
            </button>
          ))}
        </div>
        <div className={styles.aiMenuHint}>结果写入对侧 · 自动切到预览</div>
      </div>
    </>
  );
}
