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
import { X, Trash2, Brain, RefreshCw } from "lucide-react";
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
import { useToast } from "@/components/Toast";
import styles from "./Learnings.module.css";

export function LearningsDialog() {
  const open = useDialogStore((s) => s.learningsOpen);
  const close = useCallback(() => useDialogStore.getState().closeLearnings(), []);
  const anim = useDialogAnim();
  const { toast } = useToast();

  const [stats, setStats] = useState<ActionEventStats | null>(null);
  const [dismissals, setDismissals] = useState<ActionDismissal[]>([]);
  const [busy, setBusy] = useState(false);

  /** 拉取统计 + 负反馈 */
  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([actionEventStats(30), actionDismissals()]);
      setStats(s);
      setDismissals(d);
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
