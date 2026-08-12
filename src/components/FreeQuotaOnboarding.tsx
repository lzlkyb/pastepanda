/**
 * FreeQuotaOnboarding.tsx —— v6.9 免费额度首次引导（设计稿场景 3）。
 *
 * 「送你 10 万 token 体验 AI」：新用户第一次启动时教他三件事——
 * ① 复制即用 ② 每天签到越签越多 ③ 兑换码 / 换自配服务商。
 * 主按钮直接签到领 2 万，然后打开完整额度弹窗（闭环：签到 → 看见额度 → 去用）。
 *
 * 一次性（localStorage 记已看）；仅在「未启用自配 AI 或当前就是内置免费」时出现，
 * 已配好自己的服务商的用户不受打扰（§10.11 隔离规则）。
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Gift, Flame, Sparkles, Loader2 } from "lucide-react";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { useToast } from "@/components/Toast";
import { aiQuotaSign } from "@/lib/api/quota";
import { aiGetConfig } from "@/lib/api/ai";
import { useDialogStore } from "@/stores/dialogStore";
import { fmtWan, notifyQuotaChanged, BUILTIN_AGNES_ID } from "@/lib/quota";
import styles from "./FreeQuotaOnboarding.module.css";

const SEEN_KEY = "pastepanda_free_quota_onboarded";

export function freeQuotaOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* 忽略 */
  }
}

export function FreeQuotaOnboarding() {
  const { backdrop, panel } = useDialogAnim();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [signing, setSigning] = useState(false);

  // 挂载时判定：首次 +（未启用自配 AI 或当前就是内置免费）→ 弹
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (freeQuotaOnboardingSeen()) return;
        const cfg = await aiGetConfig();
        // 已配好自配服务商且不是内置免费 → 不打扰
        if (cfg.provider !== BUILTIN_AGNES_ID && cfg.enabled) return;
        if (alive) setOpen(true);
      } catch {
        /* 拉不到配置就不弹，避免反复 */
        markSeen();
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const close = () => {
    markSeen();
    setOpen(false);
  };

  const doSignAndOpen = async () => {
    if (signing) return;
    setSigning(true);
    try {
      const r = await aiQuotaSign();
      if (r.ok) {
        const amt = r.reward > 0 ? `+${fmtWan(r.reward)} token` : "已达累计上限";
        toast(`签到成功 ${amt}，连续 ${r.streak} 天`, "success");
        notifyQuotaChanged();
      } else {
        toast(r.reason, "info");
      }
    } catch (e) {
      toast(`签到失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSigning(false);
    }
    markSeen();
    setOpen(false);
    useDialogStore.getState().openQuota();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...panel}
              className={`dialog-box w520 ${styles.box}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.hero}>
                <span className={styles.heroIcon}><Gift size={18} /></span>
                <div className={styles.heroTitle}>送你 10 万 token 体验 AI</div>
                <div className={styles.heroSub}>内置免费模型 Agnes · 签到累计可到 100 万 · 不用填 API Key</div>
              </div>

              <div className={styles.steps}>
                <div className={styles.step}>
                  <span className={styles.stepNum}><Sparkles size={11} /></span>
                  <div className={styles.stepBody}>
                    <span className={styles.stepTitle}>复制即用</span>
                    <span className={styles.stepDesc}>复制任意内容，点「翻译 / 总结 / 改写」直接出结果</span>
                  </div>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNum}><Flame size={11} /></span>
                  <div className={styles.stepBody}>
                    <span className={styles.stepTitle}>越签越多</span>
                    <span className={styles.stepDesc}>每天签到：第 1 天 2 万，每天 +1 万，封顶 5 万/天，连续 7 天共 29 万</span>
                  </div>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNum}><Gift size={11} /></span>
                  <div className={styles.stepBody}>
                    <span className={styles.stepTitle}>额度不够还有招</span>
                    <span className={styles.stepDesc}>用兑换码加量，或切换到你自己配置的服务商</span>
                  </div>
                </div>
              </div>

              <div className={styles.actions}>
                <button className={styles.primary} onClick={() => void doSignAndOpen()} disabled={signing}>
                  {signing ? <Loader2 size={12} className="spin" /> : <Flame size={12} />}
                  立即签到，领取 2 万 token
                </button>
                <button className={styles.secondary} onClick={close}>
                  暂不，谢谢
                </button>
              </div>
              <div className={styles.privacy}>
                隐私：内容会发送到内置 Agnes 服务商处理；签到与兑换不联网、不上传任何内容。
              </div>

              <button className={styles.closeBtn} aria-label="关闭" onClick={close}>
                <X size={15} />
              </button>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
