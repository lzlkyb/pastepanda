/**
 * QuotaDialog —— 免费额度签到弹窗（v6.9）。
 *
 * 内容（与 design/签到送Token-v6.9-设计稿.html 场景 1 一致）：
 * - 余额环形 + 已用/累计进度条
 * - 签到徽章阶梯（已签 ✓ / 今天呼吸光环 / 未来灰态）
 * - 兑换码输入（离线验证，本地幂等）
 *
 * 纯本地记账，不联网、不含内容；仅内置免费服务商使用。
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Gift, Flame, Check, Ticket, Sparkles } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { useToast } from "@/components/Toast";
import { rewardOf, fmtWan, ladderCells, notifyQuotaChanged, BUILTIN_AGNES_ID } from "@/lib/quota";
import { aiGetConfig, aiGetProviderConfig, aiSetConfig } from "@/lib/api/ai";
import { notifyAiConfigWritten } from "@/lib/aiAvailability";
import {
  aiQuotaGet,
  aiQuotaSign,
  aiQuotaRedeem,
  type QuotaInfo,
} from "@/lib/api/quota";
import styles from "./QuotaDialog.module.css";

export function QuotaDialog() {
  const open = useDialogStore((s) => s.quotaOpen);
  const close = useCallback(() => useDialogStore.getState().closeQuota(), []);
  const anim = useDialogAnim();
  const { toast } = useToast();

  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [signing, setSigning] = useState(false);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // v6.9 缺陷修复：当前服务商不是内置免费 → 显示「一键启用」闭环引导
  const [needEnable, setNeedEnable] = useState(false);
  const [enabling, setEnabling] = useState(false);

  const load = useCallback(async () => {
    try {
      setQuota(await aiQuotaGet());
    } catch (e) {
      toast(`读取额度失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      void load();
      // 闭环：不是内置免费服务商时给一键启用引导（用户签到完就能立刻用）
      aiGetConfig()
        .then((cfg) => setNeedEnable(cfg.provider !== BUILTIN_AGNES_ID))
        .catch(() => setNeedEnable(false));
    } else {
      setQuota(null);
      setNeedEnable(false);
    }
  }, [open, load]);

  const doEnableBuiltin = useCallback(async () => {
    if (enabling) return;
    setEnabling(true);
    try {
      const cfg = await aiGetConfig();
      // 只改 provider/enabled 是不够的：cfg 里的 baseUrl/model/protocol 还是上一家的
      // （比如 deepseek 的地址 + deepseek-chat），带着它们配 Agnes 的内置 key 去请求必然失败,
      // 「点一下就能用」就成了空话。跟 changeProvider 走同一条回填：读这家已保存的值，
      // 没存过就是空串，后端 effective_base_url/effective_model 会回退到 builtin-agnes 的默认。
      const pc = await aiGetProviderConfig(BUILTIN_AGNES_ID);
      await aiSetConfig({
        ...cfg,
        provider: BUILTIN_AGNES_ID,
        enabled: true,
        baseUrl: pc.baseUrl,
        model: pc.model,
        protocol: pc.protocol ?? "",
      });
      // 落盘之后还必须让判据和别的组件跟上——这一步以前漏了：库里已经是「启用」，
      // 可判定结果有 30 秒缓存、别的窗口也没收到通知，于是设置页 / 胶囊 / 变换门控
      // 全都照旧显示未启用。用户点完看到「现在就能用了」，却发现哪儿都没变。
      await notifyAiConfigWritten();
      setNeedEnable(false);
      toast("已切换为内置免费 AI，现在就能用了", "success");
    } catch (e) {
      toast(`启用失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setEnabling(false);
    }
  }, [enabling, toast]);

  const doSign = useCallback(async () => {
    if (signing) return;
    setSigning(true);
    try {
      const r = await aiQuotaSign();
      if (r.ok) {
        // v6.9 缺陷修复：签到到累计上限后 reward=0，文案不说「+0 万」
        const amt =
          r.reward > 0
            ? `+${fmtWan(r.reward)} token`
            : r.reason !== "ok"
              ? "已达累计上限（火焰保持）"
              : "今日额度已满";
        toast(`签到成功：${amt}，连续 ${r.streak} 天${r.reason !== "ok" && r.reward > 0 ? `（${r.reason}）` : ""}`, "success");
        notifyQuotaChanged();
      } else {
        toast(r.reason, "info");
      }
      await load();
    } catch (e) {
      toast(`签到失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSigning(false);
    }
  }, [signing, load, toast]);

  const doRedeem = useCallback(async () => {
    const c = code.trim();
    if (!c || redeeming) return;
    setRedeeming(true);
    setRedeemMsg(null);
    try {
      const r = await aiQuotaRedeem(c);
      setRedeemMsg(
        r.ok
          ? { ok: true, text: `兑换成功：+${fmtWan(r.amount)} token` }
          : { ok: false, text: r.reason },
      );
      if (r.ok) {
        setCode("");
        notifyQuotaChanged();
        await load();
      }
    } catch (e) {
      setRedeemMsg({ ok: false, text: `兑换失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRedeeming(false);
    }
  }, [code, redeeming, load]);

  // v6.10：兑换码自动粘贴（读剪贴板，失败静默）
  const pasteCode = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      const c = t.trim();
      if (c) setCode(c);
    } catch {
      toast("无法读取剪贴板，请手动输入", "info");
    }
  }, [toast]);

  // v6.10：3 分区标题（余额 / 每日签到 / 兑换码）
  const GroupTitle = ({ text }: { text: string }) => (
    <div className={styles.groupTitle}><span className={styles.gDot} />{text}</div>
  );

  const pct = quota ? Math.round(((quota.granted + quota.spent > 0 ? quota.granted : 1) / (quota.granted + quota.spent)) * 100) : 0;
  const usedPct = 100 - pct;

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <motion.div
            {...anim.panel}
            className="dialog-box w420"
            role="dialog"
            aria-modal="true"
            aria-label="免费额度"
            onClick={(e) => e.stopPropagation()}
          >
            <FocusTrap active={open}>
              <div className={styles.box}>
                <div className={styles.head}>
                  <div className={styles.headTitle}>
                    <span className={styles.headIcon}><Gift size={13} /></span>
                    免费额度
                    <span className={styles.headSub}>内置 Agnes · 内容会发送到该服务商</span>
                  </div>
                  <button className="dialog-close" onClick={close} aria-label="关闭">
                    <X size={14} />
                  </button>
                </div>

                <div className={styles.body}>
                  {/* v6.9 缺陷修复：当前不是内置免费服务商 → 一键启用闭环（签到完就能用） */}
                  {needEnable && (
                    <div className={styles.enableBanner}>
                      <span className={styles.enableText}>
                        <Sparkles size={12} /> 当前 AI 用的是你自己的服务商——点一下切到内置免费，立刻用这份额度
                      </span>
                      <button
                        className={styles.enableBtn}
                        onClick={() => void doEnableBuiltin()}
                        disabled={enabling}
                      >
                        {enabling ? <Loader2 size={11} className="spin" /> : "一键启用内置免费"}
                      </button>
                    </div>
                  )}

                  {!quota ? (
                    <div className={styles.loading}>
                      <Loader2 size={16} className="spin" /> 加载中…
                    </div>
                  ) : (
                    <>
                      {/* v6.10 分区：余额（环形中心改「已用」语义，避免方向误解） */}
                      <GroupTitle text="余额" />
                      <div className={styles.main}>
                        <div
                          className={styles.ring}
                          style={{ background: `conic-gradient(var(--accent-strong) 0 ${Math.max(2, usedPct)}%, var(--section-bg) ${Math.max(2, usedPct)}% 100%)` }}
                        >
                          <div className={styles.ringInner}>
                            <b>{usedPct}%</b>
                            <span>已用</span>
                          </div>
                        </div>
                        <div className={styles.meta}>
                          <div className={styles.metaTitle}>
                            剩余 <b>{fmtWan(quota.remaining)}</b>
                          </div>
                          <div className={styles.bar}>
                            <div className={styles.barFill} style={{ width: `${Math.max(2, usedPct)}%` }} />
                          </div>
                          <div className={styles.metaNote}>
                            已用 {fmtWan(quota.spent)} / 累计 {fmtWan(quota.granted + quota.spent)} · 签到累计到 100 万上限 · 兑换码不设上限 · 缓存命中不计费
                          </div>
                        </div>
                      </div>

                      {/* v6.10 分区：每日签到 */}
                      <GroupTitle text="每日签到" />
                      {/* 签到阶梯 */}
                      <div className={styles.signBox}>
                        <div className={styles.signHead}>
                          <div className={styles.medal}>
                            <b>{quota.signStreak}</b>
                            <span>天</span>
                          </div>
                          <div className={styles.signInfo}>
                            <span className={styles.signTitle}>
                              <Flame size={12} /> 连续签到 {quota.signStreak} 天
                            </span>
                            <span className={styles.signSub}>
                              {quota.canSign
                                ? `今天签完第 ${quota.signStreak + 1} 天，连续 7 天拿满 ${fmtWan(quota.weekTotal)}`
                                : "明天见，别让火焰熄灭"}
                            </span>
                          </div>
                          <div className={styles.signTotal}>
                            <span>连续 7 天共得</span>
                            <b>{fmtWan(quota.weekTotal)}</b>
                          </div>
                        </div>

                        <div className={styles.ladder}>
                          {ladderCells(quota).map((c) => (
                            <div
                              key={c.key}
                              className={`${styles.day} ${c.done ? styles.dayDone : ""} ${c.today ? styles.dayToday : ""} ${c.future ? styles.dayFuture : ""}`}
                              title={c.done ? `已签到 · ${fmtWan(c.reward)}` : c.reward > 0 ? `可得 ${fmtWan(c.reward)}` : "已达累计上限"}
                            >
                              <span className={styles.badge}>
                                {c.done ? <Check size={12} /> : c.reward / 10000}
                                {c.today && !c.done && <span className={styles.todayChip}>今天</span>}
                              </span>
                              <span className={styles.dayLabel}>{c.label}</span>
                              {/* v6.9 缺陷修复：封顶后 reward=0 不再显示「+0 万」 */}
                              <span className={styles.dayAmt}>
                                {c.done ? "已签" : c.reward > 0 ? `+${fmtWan(c.reward)}` : "已满"}
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className={styles.signCta}>
                          <button
                            className={`${styles.signBtn} ${!quota.canSign ? styles.signBtnDone : ""}`}
                            onClick={() => void doSign()}
                            disabled={signing || !quota.canSign}
                          >
                            {signing ? <Loader2 size={12} className="spin" /> : quota.canSign ? <Flame size={12} /> : <Check size={12} />}
                            {signing
                              ? "签到中…"
                              : quota.canSign
                                ? `今日签到 +${fmtWan(rewardOf(quota.signStreak + 1))}`
                                : "今日已签到"}
                          </button>
                          <span className={styles.signHint}>
                            断签将从第 1 天重新开始
                          </span>
                        </div>
                      </div>

                      {/* v6.10 分区：兑换码（增强：粘贴按钮 + 规则说明） */}
                      <GroupTitle text="兑换码" />
                      {/* 兑换码 */}
                      <div className={styles.redeem}>
                        <div className={styles.redeemRow}>
                          <Ticket size={12} className={styles.redeemIcon} />
                          <input
                            className={styles.redeemInput}
                            placeholder="P1-XXXX-XXXX"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && void doRedeem()}
                            spellCheck={false}
                          />
                          <button className={styles.pasteCode} onClick={() => void pasteCode()} title="从剪贴板粘贴兑换码">
                            粘贴
                          </button>
                          <button
                            className={styles.redeemBtn}
                            onClick={() => void doRedeem()}
                            disabled={redeeming || !code.trim()}
                          >
                            {redeeming ? <Loader2 size={11} className="spin" /> : "兑换"}
                          </button>
                        </div>
                        {redeemMsg && (
                          <div className={redeemMsg.ok ? styles.redeemOk : styles.redeemErr}>
                            {redeemMsg.ok ? <Check size={11} /> : "⚠"} {redeemMsg.text}
                          </div>
                        )}
                        <div className={styles.redeemHelp}>
                          兑换码由活动 / 社区发放 · 不设上限 · 已用码不能重复兑换
                        </div>
                      </div>

                      {/* 隔离说明 */}
                      <div className={styles.note}>
                        <b>与自配服务商隔离：</b>免费额度只在你选「内置 Agnes」时生效；
                        切到自己配置的服务商后按金额计费，免费额度原样保留、互不冲突。
                        <br />
                        <b>隐私：</b>token 计量在本地；签到与兑换不联网、不上传任何内容。
                      </div>
                    </>
                  )}
                </div>
              </div>
            </FocusTrap>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
