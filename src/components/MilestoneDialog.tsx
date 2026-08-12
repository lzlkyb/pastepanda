/**
 * MilestoneDialog —— 里程碑时刻（v6.8 粘性 B1）。
 *
 * 挂载时自检一次：`checkMilestones` 命中则展示（先标记已读再打开，天然幂等，
 * 刷新/重挂载不会重复弹）；关闭即收下。文案里的数字全部来自本地统计，无内容。
 */
import { useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { statsSticky } from "@/lib/api/sticky";
import { checkMilestones, markMilestoneSeen, type MilestoneEvent } from "@/lib/milestones";
import styles from "./MilestoneDialog.module.css";

export function MilestoneDialog() {
  const milestone = useDialogStore((s) => s.milestone);
  const anim = useDialogAnim();

  // 启动自检：命中则先标记已读、再打开（幂等，不会重复弹）
  useEffect(() => {
    if (useDialogStore.getState().milestone) return;
    let cancelled = false;
    void statsSticky()
      .then((s) => {
        if (cancelled) return;
        const m = checkMilestones(s);
        if (m) {
          markMilestoneSeen(m.kind, m.stamp);
          useDialogStore.getState().openMilestone(m);
        }
      })
      .catch(() => {
        /* 统计拉不到就不打扰 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => {
    const m: MilestoneEvent | null = useDialogStore.getState().milestone;
    if (m) markMilestoneSeen(m.kind, m.stamp);
    useDialogStore.getState().closeMilestone();
  }, []);

  const goProfile = useCallback(() => {
    const m: MilestoneEvent | null = useDialogStore.getState().milestone;
    if (m) markMilestoneSeen(m.kind, m.stamp);
    useDialogStore.getState().closeMilestone();
    useDialogStore.getState().openProfile();
  }, []);

  const tone = milestone?.kind === "awakening" ? "purple" : milestone?.kind === "hundred-k" ? "green" : "blue";

  return (
    <AnimatePresence>
      {milestone && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <motion.div
            {...anim.panel}
            className={`dialog-box w520 ${styles.box}`}
            role="dialog"
            aria-modal="true"
            aria-label="里程碑"
            onClick={(e) => e.stopPropagation()}
          >
            <FocusTrap active={!!milestone}>
              <div className={styles.ms}>
                <button className={styles.x} onClick={close} aria-label="关闭">
                  <X size={14} />
                </button>
                <div className={`${styles.burst} ${styles[tone]}`}>{milestone.icon}</div>
                <div className={`${styles.tag} ${styles[`tag${tone === "blue" ? "Blue" : tone === "green" ? "Green" : "Purple"}`]}`}>
                  {milestone.tag}
                </div>
                <div className={styles.title}>{milestone.title}</div>
                <div className={styles.quote}>{milestone.quote}</div>
                {milestone.stats.length >= 3 && (
                  <div className={styles.stats}>
                    {milestone.stats.map((s) => (
                      <div key={s.label} className={styles.stat}>
                        <b>{s.value}</b>
                        <span>{s.label}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className={styles.btns}>
                  <button className={styles.btn} onClick={goProfile}>
                    查看我的画像
                  </button>
                  <button className={styles.btnPrimary} onClick={close}>
                    收下这份回忆
                  </button>
                </div>
              </div>
            </FocusTrap>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
