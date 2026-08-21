/**
 * SignFloat —— 左下角每日签到浮窗（v6.9，WorkBuddy 式）。
 *
 * 触发（每天一次，本地记录）：
 * - 今天未弹过 + 今天未签到 + AI 已启用 + 当前是内置免费服务商
 *   （AI 关闭/未启用 → 不弹，见下方 enabled 门控；配了自己的服务商 → 不打扰）
 * 交互：非 modal 不打断操作；点签到 → 成功态 1.8s 自动收起；✕ → 收起当天不再弹；
 * 「查看额度明细 →」打开完整签到弹窗。首日（初始额度未动）显示「送你 10 万 token」。
 */
import { useEffect, useRef, useState } from "react";
import { X, Gift, Flame, Check, ChevronRight } from "lucide-react";
import { aiGetConfig } from "@/lib/api/ai";
import { aiQuotaGet, aiQuotaSign, type QuotaInfo } from "@/lib/api/quota";
import { useDialogStore } from "@/stores/dialogStore";
import { useToast } from "@/components/Toast";
import { INITIAL_GRANT, rewardOf, fmtWan, notifyQuotaChanged } from "@/lib/quota";
import styles from "./SignFloat.module.css";

const POPUP_KEY = "pastepanda_quota_popup_date";

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function SignFloat() {
  const { toast } = useToast();
  const [visible, setVisible] = useState(false);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [signed, setSigned] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(POPUP_KEY) === todayStr()) return;
        const cfg = await aiGetConfig();
        // AI 关闭 / 从未启用 → 不打扰（用户诉求：AI 关了就不要每天弹签到框）
        if (!cfg.enabled) return;
        // 用户配了自己的服务商且不是内置免费 → 不打扰（§10.11 隔离规则）
        if (cfg.provider !== "builtin-agnes") return;
        const q = await aiQuotaGet();
        if (!q.canSign) return; // 今天已签
        if (cancelled) return;
        setQuota(q);
        setVisible(true);
      } catch {
        /* 拉不到就不弹 */
      }
    })();
    return () => {
      cancelled = true;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(POPUP_KEY, todayStr());
    } catch {
      /* 忽略 */
    }
    setVisible(false);
  };

  const doSign = async () => {
    try {
      const r = await aiQuotaSign();
      if (r.ok) {
        setSigned(true);
        setQuota(await aiQuotaGet());
        // v6.9 缺陷修复：封顶后 reward=0 不说「+0 万」
        const amt =
          r.reward > 0
            ? `+${fmtWan(r.reward)}`
            : r.reason !== "ok"
              ? "已达累计上限"
              : "今日额度已满";
        toast(`签到成功 ${amt}，连续 ${r.streak} 天`, "success");
        notifyQuotaChanged();
        // 1.8s 后自动收起 + 今天不再弹
        hideTimer.current = setTimeout(dismiss, 1800);
      } else {
        toast(r.reason, "info");
        dismiss();
      }
    } catch (e) {
      toast(`签到失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const openDetail = () => {
    dismiss();
    useDialogStore.getState().openQuota();
  };

  if (!visible || !quota) return null;

  const firstDay = quota.granted === INITIAL_GRANT && quota.signStreak === 0 && !signed;
  // 今天可得的奖励：未签 = 第 streak+1 天；已签 = 今天已入账的第 streak 天
  const todayReward = signed ? rewardOf(quota.signStreak) : rewardOf(quota.signStreak + 1);

  return (
    <div className={styles.floatCard}>
      <button className={styles.x} onClick={dismiss} aria-label="关闭">
        <X size={11} />
      </button>
      <div className={styles.head}>
        <span className={styles.headIcon}>{signed ? <Check size={11} /> : <Gift size={11} />}</span>
        {signed ? "签到成功" : firstDay ? "送你 10 万 token" : "每日签到"}
      </div>
      <div className={styles.body}>
        <div className={styles.medal}>
          <b>{quota.signStreak}</b>
          <span>天</span>
        </div>
        <div className={styles.info}>
          <div className={styles.title}>
            {signed ? (
              <><Check size={11} /> 连续签到 {quota.signStreak} 天</>
            ) : (
              <><Flame size={11} /> 连续签到 {quota.signStreak} 天</>
            )}
          </div>
          <div className={styles.sub}>
            {signed
              ? quota.signAdded >= quota.signCap - INITIAL_GRANT
                ? "已达累计上限 · 明天见，别让火焰熄灭"
                : `+${fmtWan(todayReward)} 已到账 · 明天可得 ${fmtWan(rewardOf(quota.signStreak + 1))}`
              : quota.signAdded >= quota.signCap - INITIAL_GRANT
                ? "签到累计已达 100 万上限 · 火焰保持"
                : `今天签到得 ${fmtWan(todayReward)} · 连续 7 天共 ${fmtWan(quota.weekTotal)}`}
          </div>
        </div>
        <button className={`${styles.btn} ${signed ? styles.btnDone : ""}`} onClick={() => void doSign()} disabled={signed}>
          {signed ? "✓ 已签到" : <><Flame size={11} /> 签到</>}
        </button>
      </div>
      <div className={styles.foot}>
        <span>初始 10 万 · 签到累计到 100 万</span>
        <button className={styles.detail} onClick={openDetail}>
          查看额度明细 <ChevronRight size={10} />
        </button>
      </div>
    </div>
  );
}
