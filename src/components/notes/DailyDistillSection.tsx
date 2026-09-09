/**
 * 今日蒸馏（P1）——把当天的剪贴板碎片聚成几篇**草稿**。
 *
 * # 为什么不写进 `KbInboxPanel`
 *
 * 两者回答的是不同问题：待沉淀答「**这一条**值不值得留」，
 * 蒸馏答「**这一堆**合起来值不值得留」。而且待沉淀为空时整个面板不渲染，
 * 写进去就会变成「没候选就也看不到蒸馏」——而那正是最需要它的时候。
 *
 * # 🔴 三条红线
 *
 * 1. **不自动落库**：采纳只是把草稿预填进笔记弹窗，存不存你说了算（守 D13）。
 * 2. **不做全文搬运**：摄录由后端夹到 60 字，前端拿不到全文。
 * 3. **产出上限**：每天最多 3 篇（`MAX_DRAFTS_PER_DAY`）。
 *
 * # P3：「AI 成文」是手动的，不是自动的
 *
 * P1/P2 只能「聚」（纯词面，离线、零成本），点了那个按钮才「炼」。
 * 发出去的就是卡片上已经渲染给你看过的那几行，**不多一个字**；
 * 不点就一分钱不花、一个字节不出网。详见 `runAi`。
 *
 * # ⚠ 采纳后草稿不会自己消失
 *
 * 因为我们**无法知道你在弹窗里到底存没存**。两个选择：
 * ① 一点采纳就标记已处理——你若取消了，草稿当天静默消失；
 * ② 只有你明确点「忽略」才消失——代价是存完之后它还在那儿。
 * 选了②：**多一行可见的冗余，好过一条静默消失的内容**。
 */
import { useCallback, useEffect, useState } from "react";
import { Sparkles, Undo2, Wand2 } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { historyDayExcerpts, historyRecentExcerpts, toIsoDate } from "@/lib/api/dailyBrief";
import {
  buildDailyDrafts,
  buildDistillPayload,
  buildTopicDrafts,
  parseDistillResult,
  TOPIC_LOOKBACK_DAYS,
  type DistillDraft,
} from "@/lib/notes/distill";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { aiRun } from "@/lib/api/ai";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { budgetExceededMessage } from "@/lib/aiBudgetMsg";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import styles from "./KbInboxPanel.module.css";

/**
 * 忽略记录放 `localStorage` 而不建表。
 *
 * 它是**当天有效**的 UI 状态，不是数据：过了今天就无意义了。
 * 为它建表还得配一套清理策略，而那正是 `daily_brief` 表被拍板不建的理由。
 * 代价：不跨机同步。可接受——在另一台机器上重新看到今天的草稿不算损失。
 */
function dismissKey(date: string): string {
  return `pp.distill.dismissed.${date}`;
}

function loadDismissed(date: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissKey(date));
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function DailyDistillSection() {
  const today = toIsoDate(new Date());
  const [drafts, setDrafts] = useState<DistillDraft[]>([]);
  const [lastDismissed, setLastDismissed] = useState<DistillDraft | null>(null);
  /** 正在成文的那篇的 key。同时只允许一篇——每一次都花用户的钱 */
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const openNote = useDialogStore((s) => s.openNote);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    const dismissed = loadDismissed(today);
    // 两条管线并行拉：P1 只看今天，P2 要回看一周。
    // 各自独立限量（3 + 2），合起来才不会淹——见 distill.ts 的红线③。
    const [dayRows, weekRows] = await Promise.all([
      historyDayExcerpts(today),
      historyRecentExcerpts(TOPIC_LOOKBACK_DAYS),
    ]);
    setDrafts([
      ...buildDailyDrafts(dayRows, today, dismissed),
      ...buildTopicDrafts(weekRows, dismissed),
    ]);
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 笔记弹窗关了就重算：存了的话那些卡片可能已经不再是候选。
  useNoteDialogClosed(reload);

  const dismiss = useCallback(
    (d: DistillDraft) => {
      const set = loadDismissed(today);
      set.add(d.key);
      try {
        localStorage.setItem(dismissKey(today), JSON.stringify([...set]));
      } catch (e) {
        logger.warn("蒸馏忽略记录写入失败", e);
      }
      setLastDismissed(d);
      setDrafts((cur) => cur.filter((x) => x.key !== d.key));
    },
    [today],
  );

  /**
   * P3：把这一簇摘录发给**用户自己配的** AI，写成一篇草稿。
   *
   * 🔴 三条红线：
   * 1. **只能手动触发**——后台批量跑 = 烧用户的钱 + 无声出网，两条都踩；
   * 2. **仍不落库**——模型写完还是进 `openNote` 预填，与采纳路径同一条；
   * 3. **三态全接**——needsConfirm / budgetExceeded / truncated 各自有说法。
   *
   * 命名函数表达式（`run`）是为了 needsConfirm 后能递归重发：
   * force 只能由用户在 toast 上按出来，**绝不自动重发**。
   */
  const runAi = useCallback(
    async function run(d: DistillDraft, force = false): Promise<void> {
      if (!isAiAvailable()) {
        toast("请先在设置里配置 AI", "info");
        return;
      }
      setAiBusy(d.key);
      try {
        // 载荷只含已被夹到 60 字的摘录（见 buildDistillPayload 的红线）
        const r = await aiRun("ai-distill-draft", buildDistillPayload(d), undefined, force);
        if (r.status === "ok" && r.content.trim()) {
          // 截断必须说出来：不说，用户会把「断在半句」当成模型水平差
          if (r.truncated) toast("写到上限被截断了，采纳后请自己补个结尾", "info", 6000);
          const parsed = parseDistillResult(r.content, d.title);
          openNote({ title: parsed.title, content: parsed.content });
        } else if (r.status === "needsConfirm") {
          toast(r.reason, "info", 12000, () => void run(d, true), "确认发送");
        } else if (r.status === "budgetExceeded") {
          toast(budgetExceededMessage(r.spentCny, r.budgetCny), "info", 6000);
        } else {
          toast("成文失败，请重试", "info");
        }
      } catch (e) {
        logger.warn("蒸馏成文失败", e);
        toast("成文失败，请重试", "info");
      } finally {
        setAiBusy(null);
      }
    },
    [openNote, toast],
  );

  const undo = useCallback(() => {
    if (!lastDismissed) return;
    const set = loadDismissed(today);
    set.delete(lastDismissed.key);
    try {
      localStorage.setItem(dismissKey(today), JSON.stringify([...set]));
    } catch (e) {
      logger.warn("蒸馏忽略撤销失败", e);
    }
    setLastDismissed(null);
    void reload();
  }, [lastDismissed, today, reload]);

  // 没草稿就整个不渲染。一个写着「今天没有可蒸馏的」的空区比没有更差。
  if (drafts.length === 0 && !lastDismissed) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.distillHead}>
        <Sparkles size={13} className={styles.bannerIcon} />
        <span className={styles.bannerText}>
          可蒸馏 <b>{drafts.length}</b> 篇草稿
          <span className={styles.bannerHint}>
            ，今天的按「来源 × 类型」聚，跨天的按主题聚；存不存你说了算
          </span>
        </span>
      </div>

      {lastDismissed && (
        <div className={styles.undoBar}>
          <span className={styles.undoText}>已忽略「{lastDismissed.title}」</span>
          <button type="button" className={styles.undoBtn} onClick={undo}>
            <Undo2 size={11} /> 撤销
          </button>
          <button
            type="button"
            className={styles.undoClose}
            onClick={() => setLastDismissed(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      <div className={styles.list}>
        {drafts.map((d) => (
          <div key={d.key} className={styles.row}>
            <span className={`${styles.badge} ${styles.badgeDistill}`}>
              <Sparkles size={9} />
              {d.count} 条
            </span>
            <div className={styles.rowBody}>
              <div className={styles.rowTitle}>{d.title}</div>
              <div className={styles.rowSignal}>
                {d.source} · {d.typeLabel} · 已拟好正文，采纳后可直接改
              </div>
            </div>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                // 只预填弹窗，**不落库**。不传 historyId：这篇是 N 条聚的，
                // 挂到其中任何一条上都是假的归属。
                onClick={() => openNote({ title: d.title, content: d.content })}
              >
                采纳为笔记
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={aiBusy !== null}
                onClick={() => void runAi(d)}
                title="把这一簇摘录发给你自己配的 AI，写成一篇草稿；不点就不发"
              >
                <Wand2 size={11} /> {aiBusy === d.key ? "写作中…" : "AI 成文"}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => dismiss(d)}>
                忽略
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
