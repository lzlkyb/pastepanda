/**
 * DailyBriefDialog.tsx —— 每日整理（H3 行为层）。
 *
 * # 零内容出网
 *
 * 只读五列元信息（`history_day_meta`），**不读 `text` 与 `content`**；
 * AI 小结发给模型的也只有数字与来源名。内容层授权读原文是下一期（C3）。
 *
 * # 不存任何东西
 *
 * 行为层每次打开实时算（规划 §5.4 那张 `daily_brief` 表已拍板不建）。
 * 唯一会写入的是「存入今日速记」，走已有的 `noteAppendDaily`。
 *
 * # 形状复用 WeekReportDialog
 *
 * 数字卡 / 横条 / AI 紫框 / 冷启动态都是它的样式，
 * 本组件新增的只有「时间线」一种块。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Loader2, CalendarDays } from "lucide-react";
import { aiRun } from "@/lib/api/ai";
import { noteAppendDaily } from "@/lib/api/noteDaily";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { contentTypeLabel } from "@/lib/actionLabels";
import { segmentByGap, EVENT_GAP_SECS } from "@/lib/events";
import {
  historyDayMeta,
  toIsoDate,
  prevDay,
  MIN_SEGMENTS,
  type DayMetaRow,
} from "@/lib/api/dailyBrief";
import { briefToText, dayTitle, TYPE_LABELS } from "@/lib/dailyBrief";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./WeekReportDialog.module.css";

export const DailyBriefDialog = memo(function DailyBriefDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const [date, setDate] = useState(() => toIsoDate(new Date()));
  const [rows, setRows] = useState<DayMetaRow[] | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setAiText(null);
    setSaved(false);
    void historyDayMeta(date).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [date]);

  const segments = useMemo(
    () => (rows ? segmentByGap(rows, EVENT_GAP_SECS) : []),
    [rows],
  );

  /** 全天类型分布（按次数降序）。 */
  const typeBars = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const handleAi = useCallback(async () => {
    if (!isAiAvailable()) {
      toast("请先在设置里配置 AI", "info");
      return;
    }
    setAiLoading(true);
    try {
      // 喂进去的只有数字与来源名（briefToText 构造，已配单测钉死不含内容）
      const r = await aiRun("ai-daily-brief", briefToText(date, segments, typeBars));
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
  }, [date, segments, typeBars, toast]);

  const handleSave = useCallback(async () => {
    if (!aiText) return;
    const r = await noteAppendDaily(`【${dayTitle(date)} 整理】\n${aiText}`, "PastePanda");
    if (!r) {
      toast("存入速记失败", "info");
      return;
    }
    // duplicate 不是错误：重复点同一段小结是常态，说一句就行
    toast(r.status === "duplicate" ? "这段刚记过了" : "已存入今日速记", "success");
    setSaved(true);
  }, [aiText, date, toast]);

  const total = rows?.length ?? 0;
  const cold = rows !== null && segments.length < MIN_SEGMENTS;
  const span =
    segments.length > 0
      ? `${segments[0].startTime} 起`
      : "—";

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div
            {...panel}
            className="dialog-panel"
            style={{ width: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <span className={styles.headerIcon}>
                <CalendarDays size={14} />
              </span>
              <span style={{ flex: 1, fontWeight: 600 }}>今日整理</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{dayTitle(date)}</span>
              <button className="dialog-close" onClick={onClose} aria-label="关闭">
                <X size={15} />
              </button>
            </div>

            {rows === null ? (
              <div className={styles.cold}>正在算……</div>
            ) : cold ? (
              <div className={styles.cold}>
                {total === 0 ? "这一天没有任何记录。" : <>这一天才攻下 <b>{total}</b> 条，分不出几段工作来。</>}
                <br />
                再攒攒，或者{" "}
                <button className={styles.aiBtn} style={{ padding: "2px 8px" }}
                  onClick={() => setDate(prevDay(date))}>
                  看看前一天
                </button>
              </div>
            ) : (
              <>
                <div className={styles.overview}>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum}>{total}</div>
                    <div className={styles.ovLabel}>条碎片</div>
                  </div>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum}>{segments.length}</div>
                    <div className={styles.ovLabel}>段工作</div>
                  </div>
                  <div className={styles.ovItem}>
                    <div className={styles.ovNum} style={{ fontSize: 16 }}>{span}</div>
                    <div className={styles.ovLabel}>
                      {segments[segments.length - 1].endTime} 止
                    </div>
                  </div>
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionTitle}>这一天的时间线</div>
                  {segments.map((s, i) => (
                    <div key={`${s.startTime}-${i}`} className={styles.segRow}>
                      <div className={styles.segTime}>
                        {s.startTime === s.endTime ? s.startTime : `${s.startTime}-${s.endTime}`}
                      </div>
                      <div className={styles.segMain}>
                        <div className={styles.segSrc}>{s.topSource}</div>
                        <div className={styles.segMeta}>
                          {s.typeCounts
                            .map((t) => `${TYPE_LABELS[t.type] ?? contentTypeLabel(t.type)} ${t.count}`)
                            .join(" · ")}
                        </div>
                      </div>
                      <div className={styles.segN}>{s.items.length} 条</div>
                    </div>
                  ))}
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionTitle}>内容类型</div>
                  <div className={styles.bars}>
                    {typeBars.map(([t, n]) => (
                      <div key={t} className={styles.barRow}>
                        <span className={styles.barLabel}>{TYPE_LABELS[t] ?? contentTypeLabel(t)}</span>
                        <span className={styles.barTrack}>
                          <span className={styles.barFill} style={{ width: `${(n / total) * 100}%` }} />
                        </span>
                        <span className={styles.barVal}>{n}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.aiBox}>
                  <div className={styles.aiLabel}>✨ AI 小结</div>
                  {aiText ? (
                    <>
                      <div className={styles.aiText}>{aiText}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button className={styles.aiBtn} onClick={handleSave} disabled={saved}>
                          {saved ? "已存入速记" : "存入今日速记"}
                        </button>
                        <button className={styles.aiBtn} onClick={handleAi} disabled={aiLoading}>
                          重新生成
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button className={styles.aiBtn} onClick={handleAi} disabled={aiLoading}>
                        {aiLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                        {aiLoading ? "生成中……" : "生成今日小结"}
                      </button>
                      <div className={styles.segMeta} style={{ marginTop: 5 }}>
                        只发送上面这些<b>数字与来源名</b>，不发送任何内容。
                      </div>
                    </>
                  )}
                </div>

                <div className={styles.actionsRow}>
                  <button className={styles.aiBtn} onClick={() => setDate(prevDay(date))}>
                    看看前一天
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});
