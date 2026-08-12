/**
 * LearningsDialog.tsx —— 「自进化」（v6.1 红线②，08-11 按 design/learning-insights.html 重设计）。
 *
 * 本地优先的可信度来源：学习日志只存本机，并且用户必须能查得到、能一键删。
 * 展示结构：KPI 概览 → 推荐偏好（常用变换）→ 已停用推荐（可恢复）→ 输出偏好调优 →
 * 本地检索记忆 → 底部清空。动作/内容类型显示中文（lib/actionLabels）。
 *
 * 常挂载 + AnimatePresence 门控退场动画（与 TransformHubDialog 同模式）。
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Trash2, Brain, RefreshCw, Save, UserRound, ShieldCheck } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { confirmDialog } from "@/lib/confirm";
import { FocusTrap } from "@/components/FocusTrap";
import {
  actionEventStats,
  actionDismissals,
  actionDismissRemove,
  actionLearningsClear,
  type ActionEventStats,
  type ActionDismissal,
} from "@/lib/api/actionEvents";
import {
  aiFeedbackStats,
  aiFeedbackClear,
  actionPrefsAll,
  actionPrefSet,
  type AiFeedbackStat,
  type ActionPrefRow,
} from "@/lib/api/aiFeedback";
import { historySummariesCount, historySummariesClear } from "@/lib/api/contentMemory";
import { semanticStatus } from "@/lib/api/semantic";
import { useToast } from "@/components/Toast";
import { actionLabel, contentTypeLabel } from "@/lib/actionLabels";
import styles from "./Learnings.module.css";

/** 编辑率阈值配色：<40% 绿 / 40–59% 琥珀 / ≥60% 红（与设计稿一致） */
function rateTone(rate: number): { cls: string; txt: string } {
  if (rate >= 60) return { cls: styles.rateRed, txt: "red" };
  if (rate >= 40) return { cls: styles.rateAmber, txt: "amber" };
  return { cls: styles.rateGreen, txt: "green" };
}

export function LearningsDialog() {
  const open = useDialogStore((s) => s.learningsOpen);
  const close = useCallback(() => useDialogStore.getState().closeLearnings(), []);
  const anim = useDialogAnim();
  const { toast } = useToast();

  const [stats, setStats] = useState<ActionEventStats | null>(null);
  const [dismissals, setDismissals] = useState<ActionDismissal[]>([]);
  const [fbStats, setFbStats] = useState<AiFeedbackStat[]>([]);
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [memCount, setMemCount] = useState<number | null>(null);
  const [semVectorCount, setSemVectorCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedPref, setSavedPref] = useState<string | null>(null);

  /** 拉取统计 + 负反馈 + AI 结果反馈 + 内容记忆 */
  const load = useCallback(async () => {
    try {
      const [s, d, fb, p, mem, sem] = await Promise.all([
        actionEventStats(30),
        actionDismissals(),
        aiFeedbackStats(30),
        actionPrefsAll(),
        historySummariesCount(),
        semanticStatus().catch(() => null),
      ]);
      setStats(s);
      setDismissals(d);
      setFbStats(fb.filter((x) => x.total >= 5));
      setPrefs(Object.fromEntries(p.map((r: ActionPrefRow) => [r.actionId, r.preference])));
      setMemCount(mem);
      setSemVectorCount(sem?.enabled ? sem.vectorCount : null);
    } catch (e) {
      toast(`读取学习记录失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [toast]);

  // 打开时拉取；关闭时清空（下次打开重新拉，避免展示过期数据）
  useEffect(() => {
    if (open) void load();
    else {
      setStats(null);
      setDismissals([]);
      setFbStats([]);
      setPrefs({});
      setMemCount(null);
      setSemVectorCount(null);
      setSavedPref(null);
    }
  }, [open, load]);

  /** 恢复一条「不再推荐」 */
  const restoreDismiss = useCallback(
    async (actionId: string, contentType: string) => {
      try {
        await actionDismissRemove(actionId, contentType);
        toast(`已恢复「${actionLabel(actionId)}」的推荐`, "success");
        void load();
      } catch (e) {
        toast(`恢复失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [load, toast],
  );

  const handleClear = useCallback(async () => {
    // 红线②：必须可删，但删除前要用户确认——学习记录虽不敏感，清掉就没了
    const ok = await confirmDialog({
      title: "清空学习记录",
      message: "清空后推荐排序会退回「对所有人一样」的状态，确定清空吗？",
      confirmText: "清空",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await actionLearningsClear();
      const { refreshRecommendState } = await import("@/lib/recommend");
      await refreshRecommendState();
      // 审查：建议条的 edit-rate 缓存也失效，否则 60s 内仍按旧数据抑制建议
      const { invalidateSuggestionFeedbackCache } = await import("@/components/SuggestionBar");
      invalidateSuggestionFeedbackCache();
      toast(`已清空 ${n} 条学习记录`, "success");
      void load();
    } catch (e) {
      toast(`清空失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [load, toast]);

  /** 保存某动作的偏好指令（清 AI 缓存，下次调用生效） */
  const savePref = useCallback(
    async (actionId: string, preference: string) => {
      try {
        const blocked = await actionPrefSet(actionId, preference);
        setSavedPref(actionId);
        window.setTimeout(() => setSavedPref((cur) => (cur === actionId ? null : cur)), 1600);
        // blocked = 后端判定这条含密钥/个人信息，出网时会被跳过。
        // 必须明说，否则用户以为存上了却永远不生效
        if (blocked) {
          toast("已保存，但这条含疑似敏感信息（密钥或个人信息），不会发给 AI 服务商，因此对云端动作不生效", "warning");
        } else {
          toast(preference ? `已保存「${actionLabel(actionId)}」偏好` : `已清除「${actionLabel(actionId)}」偏好`, "success");
        }
      } catch (e) {
        toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [toast],
  );

  /** 一键清空 AI 结果反馈 */
  const clearFeedback = useCallback(async () => {
    const ok = await confirmDialog({
      title: "清空 AI 反馈",
      message: "清空 AI 结果反馈？只影响「哪些动作常被修改」的统计，不影响偏好指令。",
      confirmText: "清空",
    });
    if (!ok) return;
    try {
      const n = await aiFeedbackClear();
      toast(`已清空 ${n} 条 AI 反馈`, "success");
      void load();
    } catch (e) {
      toast(`清空失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [load, toast]);

  /** 一键清空内容记忆（M5-1）。删了不自动补存量（红线②：删了就是删了）。 */
  const clearMemory = useCallback(async () => {
    const ok = await confirmDialog({
      title: "清空内容记忆",
      message: "清空内容记忆？之后搜索不再通过摘要辅助命中（新复制的内容仍会记）。",
      confirmText: "清空",
    });
    if (!ok) return;
    try {
      const n = await historySummariesClear();
      toast(`已清空 ${n} 条内容记忆`, "success");
      void load();
    } catch (e) {
      toast(`清空失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [load, toast]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 派生：KPI 优化信号 = 被改反馈总数；推荐偏好 max 次数（条形图基准）
  const editedTotal = fbStats.reduce((acc, s) => acc + s.edited, 0);
  const topMax = stats && stats.topActions.length > 0
    ? Math.max(1, ...stats.topActions.map((a) => a.count))
    : 1;

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w520 ${styles.box}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className={styles.head}>
                <span className={styles.headIcon}><Brain size={15} /></span>
                <div className={styles.headTitles}>
                  <div className={styles.headTitle}>自进化</div>
                  <div className={styles.headSub}>Self-Evolving · 数据仅存本机</div>
                </div>
                <button
                  className={styles.headBtn}
                  onClick={() => useDialogStore.getState().openProfile()}
                  title="查看 / 导出我的行为画像"
                >
                  <UserRound size={12} /> 我的画像
                </button>
                <button className={styles.iconBtn} onClick={() => void load()} title="刷新">
                  <RefreshCw size={14} />
                </button>
                <button className={styles.iconBtn} onClick={close} title="关闭">
                  <X size={15} />
                </button>
              </div>

              <div className={styles.body}>
                {/* 隐私说明 */}
                <div className={styles.privacy}>
                  <ShieldCheck size={13} className={styles.privacyIcon} />
                  <span>
                    PastePanda 会根据你的使用习惯自动调整变换中心的<b>推荐排序</b>。
                    以下学习数据<b>仅存本机</b>，不含任何复制内容本身，可随时查看或清空。
                  </span>
                </div>

                {!stats ? (
                  <div className={styles.empty}>加载中…</div>
                ) : (
                  <>
                    {/* KPI 概览 */}
                    <div className={styles.kpis}>
                      <div className={styles.kpi}><b>{stats.total}</b><span>近 30 天使用</span></div>
                      <div className={styles.kpi}><b>{stats.copied}</b><span>复制结果</span></div>
                      <div className={styles.kpi}><b>{stats.pasted}</b><span>粘贴结果</span></div>
                      <div className={styles.kpi}><b>{editedTotal}</b><span>优化信号</span></div>
                    </div>

                    {/* 推荐偏好 */}
                    <div className={styles.card}>
                      <div className={styles.cardHead}>
                        <span className={styles.cardIcon}>📊</span>
                        <span className={styles.cardTitle}>推荐偏好</span>
                        {stats.topActions.length > 0 && (
                          <span className={styles.cardBadge}>TOP {Math.min(5, stats.topActions.length)}</span>
                        )}
                      </div>
                      <div className={styles.cardDesc}>最常使用的变换动作——它们会排在变换中心更靠前的位置。</div>
                      {stats.topActions.length === 0 ? (
                        <div className={styles.empty}>
                          <span className={styles.emptyBig}>📭</span>
                          还没有足够的使用记录——多用几次「变换为…」，这里会显示你的偏好
                        </div>
                      ) : (
                        <div className={styles.rankList}>
                          {stats.topActions.slice(0, 5).map((a, i) => (
                            <div key={a.actionId} className={styles.rankRow}>
                              <span className={styles.rankNo}>{i + 1}</span>
                              <span className={styles.rankName}>{actionLabel(a.actionId)}</span>
                              <span className={styles.barWrap}>
                                <span className={styles.bar}>
                                  <i style={{ width: `${Math.round((a.count / topMax) * 100)}%` }} />
                                </span>
                              </span>
                              <span className={styles.rankCount}>{a.count} 次</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 已停用推荐 */}
                    <div className={styles.card}>
                      <div className={styles.cardHead}>
                        <span className={styles.cardIcon}>🚫</span>
                        <span className={styles.cardTitle}>已停用推荐</span>
                        {dismissals.length > 0 && <span className={styles.cardBadge}>{dismissals.length}</span>}
                      </div>
                      <div className={styles.cardDesc}>
                        你在这些场景点过「不再推荐」——此后再遇到同类内容不再打扰，可随时恢复。
                      </div>
                      {dismissals.length === 0 ? (
                        <div className={styles.empty}>
                          暂无停用项——点过「不再推荐」的动作会出现在这里
                        </div>
                      ) : (
                        <div className={styles.dimList}>
                          {dismissals.map((d) => (
                            <div key={`${d.actionId}\u0000${d.contentType}`} className={styles.dimRow}>
                              <span className={styles.dimName}>{actionLabel(d.actionId)}</span>
                              <span className={styles.dimTag}>{contentTypeLabel(d.contentType)}</span>
                              <button
                                className={styles.restoreBtn}
                                onClick={() => void restoreDismiss(d.actionId, d.contentType)}
                              >
                                恢复
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 输出偏好调优 */}
                    <div className={styles.card}>
                      <div className={styles.cardHead}>
                        <span className={styles.cardIcon}>🎯</span>
                        <span className={styles.cardTitle}>输出偏好调优</span>
                        {fbStats.length > 0 && (
                          <button className={styles.cardSmallBtn} onClick={() => void clearFeedback()}>
                            <Trash2 size={11} /> 清空
                          </button>
                        )}
                      </div>
                      <div className={styles.cardDesc}>
                        你「改过」的 AI 产物会被记为不满意信号。写一句偏好指令，之后调用自动带上。
                      </div>
                      {fbStats.length === 0 ? (
                        <div className={styles.empty}>
                          还没有足够反馈——AI 结果被修改后，这里会显示并可调优
                        </div>
                      ) : (
                        <div className={styles.prefList}>
                          {fbStats.map((s) => {
                            const rate = Math.round(s.editRate * 100);
                            const tone = rateTone(rate);
                            return (
                              <div key={s.actionId} className={styles.prefItem}>
                                <div className={styles.prefTop}>
                                  <span className={styles.prefName}>{actionLabel(s.actionId)}</span>
                                  <span className={styles.rateWrap}>
                                    <span className={`${styles.rate} ${tone.cls}`}>
                                      <i style={{ width: `${Math.min(100, rate)}%` }} />
                                    </span>
                                  </span>
                                  <span className={`${styles.rateTxt} ${tone.txt}`}>{rate}% 被改</span>
                                </div>
                                <div className={styles.prefRow}>
                                  {savedPref === s.actionId && <span className={styles.saved}>✓ 已保存</span>}
                                  <input
                                    className={styles.prefInput}
                                    value={prefs[s.actionId] ?? ""}
                                    placeholder="偏好指令（可选），如：更简洁"
                                    onChange={(e) =>
                                      setPrefs((p) => ({ ...p, [s.actionId]: e.target.value }))
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") void savePref(s.actionId, prefs[s.actionId] ?? "");
                                    }}
                                  />
                                  <button
                                    className={styles.prefSave}
                                    title="保存"
                                    onClick={() => void savePref(s.actionId, prefs[s.actionId] ?? "")}
                                  >
                                    <Save size={12} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* 本地检索记忆 */}
                    <div className={styles.card}>
                      <div className={styles.cardHead}>
                        <span className={styles.cardIcon}>🧩</span>
                        <span className={styles.cardTitle}>本地检索记忆</span>
                        {memCount !== null && memCount > 0 && (
                          <button className={styles.cardSmallBtn} onClick={() => void clearMemory()}>
                            <Trash2 size={11} /> 清空
                          </button>
                        )}
                      </div>
                      <div className={styles.cardDesc}>
                        为历史内容生成本地检索摘要，搜索时多一路命中。敏感内容不记，清空后不自动补。
                      </div>
                      {memCount === null ? (
                        <div className={styles.empty}>加载中…</div>
                      ) : (
                        <div className={styles.memGrid}>
                          <div className={styles.memItem}><b>{memCount.toLocaleString()}</b><span>条检索摘要</span></div>
                          {semVectorCount !== null && (
                            <div className={styles.memItem}><b>{semVectorCount.toLocaleString()}</b><span>条语义向量</span></div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* 底部操作条 */}
              <div className={styles.foot}>
                <span className={styles.footHint}>
                  数据仅存本机，用于个性化推荐排序。清空后推荐退回默认排序。
                </span>
                <button className={styles.clearBtn} onClick={() => void handleClear()} disabled={busy}>
                  <Trash2 size={13} />
                  {busy ? "清空中…" : "清空全部学习数据"}
                </button>
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
