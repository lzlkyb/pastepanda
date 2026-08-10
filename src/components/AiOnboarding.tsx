/**
 * AiOnboarding.tsx —— v6.4 主窗口 AI 感知（方案 C）：首次配置成功后的引导。
 * 3 步教育（复制 → AI 快捷区 → 变换面板），一次性（localStorage 记已看），
 * 让新用户知道 AI 从哪用、怎么用。
 */
import { memo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles } from "lucide-react";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./AiOnboarding.module.css";

/** localStorage key：看过引导 = 不再弹 */
export const AI_ONBOARDED_KEY = "pastepanda_ai_onboarded";

export function aiOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(AI_ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAiOnboardingSeen() {
  try {
    localStorage.setItem(AI_ONBOARDED_KEY, "1");
  } catch {
    /* 忽略 */
  }
}

const STEPS = [
  { title: "复制任意内容", desc: "网页、代码、长文、带敏感信息的文本……复制即捕获。" },
  { title: "主窗口直接用 AI", desc: "复制后列表上方出现 ✦ AI 快捷区，点「翻译 / 总结 / 改写」直接出结果。" },
  { title: "变换面板还有更多", desc: "脱敏、链接摘要、回复草稿、自定义动作——复制后按 Ctrl+Shift+V 都能找到。" },
];

export const AiOnboarding = memo(function AiOnboarding({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { backdrop, panel } = useDialogAnim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        markAiOnboardingSeen();
        onClose();
      }
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div
              {...panel}
              className={`dialog-box w520 ${styles.box}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.hero}>
                <span className={styles.heroIcon}><Sparkles size={18} /></span>
                <div className={styles.heroTitle}>✦ AI 已就绪</div>
                <div className={styles.heroSub}>以后复制内容，随时能用 AI 处理</div>
              </div>

              <div className={styles.steps}>
                {STEPS.map((s, i) => (
                  <div key={s.title} className={styles.step}>
                    <span className={styles.stepNum}>{i + 1}</span>
                    <div className={styles.stepBody}>
                      <span className={styles.stepTitle}>{s.title}</span>
                      <span className={styles.stepDesc}>{s.desc}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.doneBtn}
                  onClick={() => {
                    markAiOnboardingSeen();
                    onClose();
                  }}
                >
                  知道了
                </button>
              </div>
              <button
                className={styles.closeBtn}
                aria-label="关闭"
                onClick={() => {
                  markAiOnboardingSeen();
                  onClose();
                }}
              >
                <X size={15} />
              </button>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
