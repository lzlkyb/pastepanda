/**
 * LearningsDialog.tsx —— 「系统学到了什么」（v6.1 红线②）。
 *
 * 本地优先的可信度来源：学习日志只存本机，并且用户必须能查得到、能一键删。
 * 这里展示：使用统计（复制/粘贴次数、top 动作）、「不再推荐」清单，以及清空按钮。
 *
 * 常挂载 + AnimatePresence 门控退场动画（与 TransformHubDialog 同模式）。
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Trash2, Brain, RefreshCw, Save, UserRound } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import {
  actionEventStats,
  actionDismissals,
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
import styles from "./Learnings.module.css";

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
      setPrefs(Object.fromEntries(p.map((r) => [r.actionId, r.preference])));
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
    }
  }, [open, load]);

  const handleClear = useCallback(async () => {
    // 红线②：必须可删，但删除前要用户确认——学习记录虽不敏感，清掉就没了
    if (!window.confirm("清空后推荐排序会退回「对所有人一样」的状态，确定清空吗？")) return;
    setBusy(true);
    try {
      const n = await actionLearningsClear();
      const { refreshRecommendState } = await import("@/lib/recommend");
      await refreshRecommendState();
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
        await actionPrefSet(actionId, preference);
        toast(preference ? `已保存「${actionId}」偏好` : `已清除「${actionId}」偏好`, "success");
      } catch (e) {
        toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [toast],
  );

  /** 一键清空 AI 结果反馈 */
  const clearFeedback = useCallback(async () => {
    if (!window.confirm("清空 AI 结果反馈？只影响「哪些动作常被修改」的统计，不影响偏好指令。")) return;
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
    if (!window.confirm("清空内容记忆？之后搜索不再通过摘要辅助命中（新复制的内容仍会记）。")) return;
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.box}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Brain size={16} /></span>
                <h2 className="dialog-title">系统学到了什么</h2>
                <button
                  className={styles.profileBtn}
                  onClick={() => useDialogStore.getState().openProfile()}
                  title="查看 / 导出我的行为画像"
                >
                  <UserRound size={12} /> 我的画像
                </button>
                <button onClick={close} className="dialog-close"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <X size={16} />
                </button>
              </div>

              <div className={styles.note}>
                这些数据<b>只存在本机</b>，不包含任何复制内容本身。它们让变换中心的推荐排序
                越来越贴合你的习惯。这里可以随时查看，也能一键清空。
              </div>

              {!stats ? (
                <div className={styles.empty}>加载中…</div>
              ) : (
                <>
                  {/* 概览 */}
                  <div className={styles.summary}>
                    <div className={styles.sumItem}>
                      <b>{stats.total}</b>
                      <span>近 30 天使用次数</span>
                    </div>
                    <div className={styles.sumItem}>
                      <b>{stats.copied}</b>
                      <span>复制</span>
                    </div>
                    <div className={styles.sumItem}>
                      <b>{stats.pasted}</b>
                      <span>粘贴</span>
                    </div>
                  </div>

                  {/* top 动作 */}
                  <div className={styles.sectionTitle}>最常用的变换</div>
                  {stats.topActions.length === 0 ? (
                    <div className={styles.empty}>还没记录到使用——多去「变换为…」用几次试试</div>
                  ) : (
                    <div className={styles.list}>
                      {stats.topActions.map((a, i) => (
                        <div key={a.actionId} className={styles.row}>
                          <span className={styles.rank}>{i + 1}</span>
                          <span className={styles.name}>{a.actionId}</span>
                          <span className={styles.count}>{a.count} 次</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 不再推荐 */}
                  {dismissals.length > 0 && (
                    <>
                      <div className={styles.sectionTitle}>已「不再推荐」</div>
                      <div className={styles.list}>
                        {dismissals.map((d) => (
                          <div key={`${d.actionId}\u0000${d.contentType}`} className={styles.row}>
                            <span className={styles.name}>{d.actionId}</span>
                            <span className={styles.count}>
                              {d.contentType ? `仅 ${d.contentType}` : "所有内容"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {/* AI 结果反馈（M3 偏好学习） */}
                  <div className={styles.fbSection}>
                    <div className={styles.sectionTitle}>
                      AI 结果反馈
                      {fbStats.length > 0 && (
                        <button className={styles.fbClear} onClick={() => void clearFeedback()}>
                          <Trash2 size={11} /> 清空
                        </button>
                      )}
                    </div>
                    <div className={styles.fbNote}>
                      你<b>改过</b>的 AI 产物 = 对输出不满意的信号。在这里给动作写一句偏好指令
                      （如「译文更简洁」「不要译称呼」），下次调用会自动带上。
                    </div>
                    {fbStats.length === 0 ? (
                      <div className={styles.empty}>
                        还没有足够反馈——AI 结果如果被改过，这里会显示出来
                      </div>
                    ) : (
                      <div className={styles.list}>
                        {fbStats.map((s) => {
                          const rate = Math.round(s.editRate * 100);
                          return (
                            <div key={s.actionId} className={styles.fbRow}>
                              <div className={styles.fbHead}>
                                <span className={styles.name}>{s.actionId}</span>
                                <span className={rate >= 40 ? styles.rateBad : styles.rateOk}>
                                  {rate}% 被改
                                </span>
                              </div>
                              <div className={styles.fbPref}>
                                <input
                                  className={styles.fbInput}
                                  value={prefs[s.actionId] ?? ""}
                                  placeholder="偏好指令（可选），如：更简洁"
                                  onChange={(e) =>
                                    setPrefs((p) => ({ ...p, [s.actionId]: e.target.value }))
                                  }
                                />
                                <button
                                  className={styles.fbSave}
                                  onClick={() => void savePref(s.actionId, prefs[s.actionId] ?? "")}
                                >
                                  <Save size={11} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 内容记忆（M5-1） */}
                  <div className={styles.fbSection}>
                    <div className={styles.sectionTitle}>
                      内容记忆
                      {memCount !== null && memCount > 0 && (
                        <button className={styles.fbClear} onClick={() => void clearMemory()}>
                          <Trash2 size={11} /> 清空
                        </button>
                      )}
                    </div>
                    <div className={styles.fbNote}>
                      为历史内容生成的<b>本地检索摘要</b>（域名 / 邮箱 / 正文开头）——搜索时能多一路命中，
                      只在本机、敏感内容不记、清空后不自动补存量。
                    </div>
                    {memCount === null ? (
                      <div className={styles.empty}>加载中…</div>
                    ) : (
                      <div className={styles.summary}>
                        <div className={styles.sumItem}>
                          <b>{memCount}</b>
                          <span>已记忆条数</span>
                        </div>
                        {semVectorCount !== null && (
                          <div className={styles.sumItem}>
                            <b>{semVectorCount}</b>
                            <span>语义向量（M5-2）</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 清空 */}
                  <button className={styles.clearBtn} onClick={() => void handleClear()} disabled={busy}>
                    <Trash2 size={13} />
                    {busy ? "清空中…" : "清空全部学习记录"}
                  </button>
                </>
              )}

              <button className={styles.refreshBtn} onClick={() => void load()} title="刷新">
                <RefreshCw size={13} />
              </button>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
