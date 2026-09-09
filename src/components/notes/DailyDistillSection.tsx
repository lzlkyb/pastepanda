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
 * # ⚠ 采纳后草稿不会自己消失
 *
 * 因为我们**无法知道你在弹窗里到底存没存**。两个选择：
 * ① 一点采纳就标记已处理——你若取消了，草稿当天静默消失；
 * ② 只有你明确点「忽略」才消失——代价是存完之后它还在那儿。
 * 选了②：**多一行可见的冗余，好过一条静默消失的内容**。
 */
import { useCallback, useEffect, useState } from "react";
import { Sparkles, Undo2 } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { historyDayExcerpts, toIsoDate } from "@/lib/api/dailyBrief";
import { buildDailyDrafts, type DistillDraft } from "@/lib/notes/distill";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
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
  const openNote = useDialogStore((s) => s.openNote);

  const reload = useCallback(async () => {
    const rows = await historyDayExcerpts(today);
    setDrafts(buildDailyDrafts(rows, today, loadDismissed(today)));
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
          今日蒸馏 <b>{drafts.length}</b> 篇草稿
          <span className={styles.bannerHint}>，按「来源 × 类型」聚的；存不存你说了算</span>
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
