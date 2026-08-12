/**
 * WeekReportDialog.tsx —— v6.4 E 剪贴板周报（行为侧写，不读内容）。
 *
 * 只展示统计数字（内容类型分布 / 来源 Top / 时段 / 常用动作 / 粘贴转化率），
 * **不含任何剪贴板内容**——守红线（隐私）。
 *
 * - 无 AI：纯统计展示；
 * - AI 可用（规则 15 门控）：点「AI 生成周报文字」→ ai-weekly-report 把数字翻成人话；
 * - 冷启动：总记录 < 50 提示"再攒攒"。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Loader2, BarChart3 } from "lucide-react";
import { getStatsDetail, type StatsDetail } from "@/lib/api/cache";
import { actionEventStats } from "@/lib/api/actionEvents";
import { aiRun, aiGetUsageStats } from "@/lib/api/ai";
import { statsSticky, type StickyStats } from "@/lib/api/sticky";
import { suggestChallenges, type ChallengeDef } from "@/lib/challenges";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { hourBuckets, statsToText, WEEK_REPORT_MIN_EVENTS as MIN_EVENTS } from "@/lib/weekReport";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./WeekReportDialog.module.css";

/** 把统计拼成给 LLM 的文本（只含数字，无内容） */

export const WeekReportDialog = memo(function WeekReportDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const [stats, setStats] = useState<StatsDetail | null>(null);
  const [pasted, setPasted] = useState(0);
  const [topActions, setTopActions] = useState<{ actionId: string; count: number }[]>([]);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [cold, setCold] = useState(false);
  /** v6.8：本周 AI 调用次数（估算省时用）与连续活跃周数 */
  const [aiCalls, setAiCalls] = useState(0);
  const [sticky, setSticky] = useState<StickyStats | null>(null);

  // 打开时拉数据
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const workspace = "默认"; // 与仪表盘一致（后续可接当前工作区）
      const [s, events, usage, st] = await Promise.all([
        getStatsDetail(workspace),
        actionEventStats(30).catch(() => null),
        aiGetUsageStats(7).catch(() => null),
        statsSticky().catch(() => null),
      ]);
      if (cancelled) return;
      if (s) {
        setStats(s);
        if (s.total < MIN_EVENTS) setCold(true);
      }
      if (events) {
        setPasted(events.pasted ?? 0);
        setTopActions(events.topActions ?? []);
      }
      if (usage) setAiCalls(usage.totalCalls ?? 0);
      if (st) setSticky(st);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const genAi = useCallback(async () => {
    if (!stats) return;
    if (!isAiAvailable()) {
      toast("AI 未启用——先到设置里启用", "info");
      return;
    }
    setAiLoading(true);
    try {
      const r = await aiRun(
        "ai-weekly-report",
        statsToText(
          {
            total: stats.total,
            textCount: stats.text_count,
            imageCount: stats.image_count,
            fileCount: stats.file_count,
            hours: stats.hours,
            sources: stats.sources,
          },
          pasted,
          topActions,
        ),
      );
      if (r.status === "ok" && r.content.trim()) {
        setAiText(r.content.trim());
      } else if (r.status === "budgetExceeded") {
        toast("超出本月 AI 预算", "info");
      } else {
        toast("生成失败，请重试", "info");
      }
    } catch {
      toast("生成失败，请重试", "info");
    } finally {
      setAiLoading(false);
    }
  }, [stats, pasted, topActions, toast]);

  const buckets = stats ? hourBuckets(stats.hours) : null;
  const conversion = stats && stats.total > 0 ? Math.round((pasted / stats.total) * 100) : 0;
  // v6.8：AI 省时 = 7 天 AI 调用 × 单次估算 1.5 分钟（诚实标注"约/估算"）
  const aiMinutes = Math.round(aiCalls * 1.5);
  const weekStreak = sticky?.activeWeekStreak ?? 0;
  const challenges: ChallengeDef[] = sticky ? suggestChallenges(sticky) : [];

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div
            {...panel}
            className={`dialog-box w460 ${styles.box}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <span className={styles.headerIcon}><BarChart3 size={16} /></span>
              <h2 className="dialog-title">剪贴板周报</h2>
              <button onClick={onClose} className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            {!stats ? (
              <div className={styles.loading}><Loader2 size={16} className="spin" /> 加载中…</div>
            ) : cold ? (
              <div className={styles.cold}>
                数据还不多（{stats.total} 条）。继续用几天，攒到 {MIN_EVENTS} 条周报才有意义。
              </div>
            ) : (
              <>
                {/* 周概览（v6.8：+AI 省时 / 连续活跃） */}
                <div className={styles.overview}>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum}>{stats.total}</div>
                    <div className={styles.ovLabel}>复制</div>
                  </div>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum}>{pasted}</div>
                    <div className={styles.ovLabel}>已粘贴</div>
                  </div>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum}>{conversion}%</div>
                    <div className={styles.ovLabel}>转化率</div>
                  </div>
                  <div className={`${styles.ovItem} ${styles.ovHl}`}>
                    <div className={styles.ovNum}>≈{aiMinutes}<span className={styles.ovUnit}>分</span></div>
                    <div className={styles.ovLabel}>AI 省时·约</div>
                  </div>
                  <div className={`${styles.ovItem} ${styles.ovHl}`}>
                    <div className={styles.ovNum}>{weekStreak}<span className={styles.ovUnit}>周</span></div>
                    <div className={styles.ovLabel}>连续活跃</div>
                  </div>
                </div>

                {/* 内容类型 */}
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>内容类型</div>
                  <div className={styles.bars}>
                    {[
                      { label: "文本", value: stats.text_count },
                      { label: "图片", value: stats.image_count },
                      { label: "文件", value: stats.file_count },
                    ].map((b) => (
                      <div key={b.label} className={styles.barRow}>
                        <span className={styles.barLabel}>{b.label}</span>
                        <div className={styles.barTrack}>
                          <div
                            className={styles.barFill}
                            style={{ width: `${stats.total > 0 ? (b.value / stats.total) * 100 : 0}%` }}
                          />
                        </div>
                        <span className={styles.barVal}>{b.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 时段分布 */}
                {buckets && (
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>活跃时段</div>
                    <div className={styles.bars}>
                      {[
                        { label: "工作时间", value: buckets.work },
                        { label: "晚间", value: buckets.evening },
                        { label: "深夜", value: buckets.night },
                      ].map((b) => (
                        <div key={b.label} className={styles.barRow}>
                          <span className={styles.barLabel}>{b.label}</span>
                          <div className={styles.barTrack}>
                            <div
                              className={styles.barFill}
                              style={{ width: `${stats.total > 0 ? (b.value / stats.total) * 100 : 0}%` }}
                            />
                          </div>
                          <span className={styles.barVal}>{b.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 常用动作 */}
                {topActions.length > 0 && (
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>常用动作</div>
                    <div className={styles.actions}>
                      {topActions.slice(0, 5).map((a) => (
                        <span key={a.actionId} className={styles.actionChip}>
                          {a.actionId} × {a.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* v6.8 粘性 B2：本周挑战（画像驱动 · 完成零惩罚） */}
                {challenges.length > 0 && (
                  <div className={styles.section}>
                    <div className={styles.sectionTitle}>本周挑战</div>
                    <div className={styles.chalList}>
                      {challenges.slice(0, 2).map((c) => {
                        const isDone = c.done(sticky!);
                        return (
                          <div key={c.id} className={`${styles.chal} ${isDone ? styles.chalDone : ""}`}>
                            <span className={styles.chalIcon}>{c.icon}</span>
                            <div className={styles.chalInfo}>
                              <div className={styles.chalName}>{c.name}</div>
                              <div className={styles.chalDesc}>{isDone ? "已完成" : c.hint}</div>
                            </div>
                            {isDone ? (
                              <span className={styles.chalOk}>✓ 已完成</span>
                            ) : (
                              <span className={styles.chalGo}>{c.desc}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* AI 文案 */}
                {aiText && (
                  <div className={styles.aiBox}>
                    <div className={styles.aiLabel}>AI 解读</div>
                    <div className={styles.aiText}>{aiText}</div>
                  </div>
                )}

                {isAiAvailable() && (
                  <div className={styles.actionsRow}>
                    <button className={styles.aiBtn} onClick={() => void genAi()} disabled={aiLoading}>
                      {aiLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                      {aiLoading ? "生成中…" : aiText ? "重新生成" : "AI 生成周报文字"}
                    </button>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});
