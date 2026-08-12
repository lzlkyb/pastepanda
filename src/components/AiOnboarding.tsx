/**
 * AiOnboarding.tsx —— v6.4 主窗口 AI 感知（方案 C）：首次配置成功后的引导。
 * 3 步教育（复制 → AI 快捷区 → 变换面板），一次性（localStorage 记已看），
 * 让新用户知道 AI 从哪用、怎么用。
 *
 * 不只讲怎么用，也必须讲代价：以前三步全在教操作，会联网、内容发给第三方、按用量计费
 * 一个都没提；用户第一次知道价钱竟然是撞上「今日 AI 预算已用完」的时候。因此这里加了
 * 一条告知（计费 + 日预算上限在哪设）：只陈述事实，不吓人。
 */
import { memo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Info } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
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
  { icon: "⧉", title: "复制任意内容", desc: "网页、代码、长文、带敏感信息的文本……复制即捕获。" },
  { icon: "✦", title: "主窗口直接用 AI", desc: "复制后列表上方出现 ✦ AI 快捷区，点「翻译 / 总结 / 改写」直接出结果。" },
  { icon: "🎁", title: "变换面板还有更多", desc: "脱敏、链接摘要、回复草稿、自定义动作——复制后按 Ctrl+Shift+V 都能找到。" },
  { icon: "🔥", title: "免费额度 + 每日签到", desc: "内置 Agnes 送 10 万 token，每天签到越签越多——设置 → AI 可切换。" },
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
                {/* 这里曾经硬写一个 ✦ 字符，而上面 36px 的 heroIcon 已经是同一枚 Sparkles——
                    重复了。现在只把句子里的“AI”交给 AiMark 上品牌渐变（text 形态字号继承标题）。 */}
                <div className={styles.heroTitle}><AiMark shape="text" text="AI" /> 已就绪</div>
                <div className={styles.heroSub}>以后复制内容，随时能用 AI 处理</div>
              </div>

              <div className={styles.steps}>
                {STEPS.map((s) => (
                  <div key={s.title} className={styles.step}>
                    <span className={styles.stepIcon}>{s.icon}</span>
                    <div className={styles.stepBody}>
                      <span className={styles.stepTitle}>{s.title}</span>
                      <span className={styles.stepDesc}>{s.desc}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* 告知条：它是用户在第一次花钱之前唯一能看到“这事会计费”的地方，勿删 */}
              <div className={styles.notice}>
                <Info size={13} className={styles.noticeIcon} />
                <span>
                  带 ✦ 的动作会把这条内容发送给你配的 AI 服务商处理，按用量计费；
                  「粘贴脱敏」这类本地动作不出网、也不花钱。
                  费用上限默认每天 ¥3，到额自动停——在「设置 → AI → 高级设置 → 每日费用上限」可改。
                </span>
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.doneBtn}
                  onClick={() => {
                    markAiOnboardingSeen();
                    onClose();
                  }}
                >
                  知道了，开始用
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
