/**
 * 待沉淀区面板（知识库 A 阶段 · 规划 §8.1 4️⃣，设计稿 §5）。
 *
 * 「知识」模式顶部的横幅 + 可展开候选列表。四条硬规则来自设计稿：
 * ① **首屏只 20 条**（存量 225 条一次铺开 = 收件箱破产）；
 * ② **永不弹 toast**（§5-4）：候选增减只在横幅计数上体现，不打断粘贴主流程；
 * ③ **忽略是整卡粒度**；
 * ④ 候选行直接复用卡片的文本预览 / 来源 / 时间。
 *
 * 默认**收起**：它是被动面板，不应一进知识模式就用 20 条待办撑死笔记列表。
 *
 * 🔴 红线：无 AI。候选全由本机信号算出。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Inbox, Star, Search, Undo2 } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { relativeTime } from "@/lib/utils";
import { extractNoteDraft } from "@/lib/notes/extract";
import { openNoteForCard } from "@/lib/notes/open";
import {
  kbInboxList,
  kbInboxCount,
  kbInboxDismiss,
  kbInboxUndismiss,
  type InboxCandidate,
} from "@/lib/api";
import styles from "./KbInboxPanel.module.css";

/** 首屏与每批条数。设计稿 §5-2b 定的 20。 */
const BATCH = 20;

/** 信号说明行。
 *
 * ❗ **比设计稿少一句「最近一次在今天 14:32」**：history 表只有 `search_hit_count`
 *   计数列，**没有最后一次命中时间**。编一个时间比不写更糟；同理收藏也没有
 *   「收藏时间」（`pinned` 就是个布尔）。能说的只有采集时间，就只说它。
 */
function signalText(c: InboxCandidate): string {
  const when = relativeTime(c.item.time);
  if (c.reason === "star") {
    return c.item.source ? `已收藏 · 来自 ${c.item.source} · ${when}采集` : `已收藏 · ${when}采集`;
  }
  return `你搜索找回来过 ${c.search_hit_count} 次 · ${when}采集`;
}

export function KbInboxPanel() {
  const [expanded, setExpanded] = useState(false);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<InboxCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  /** 刚忽略掉的那一条，给一个可撤销的窗口。不用 toast（②），就在原位给条提示 */
  const [justDismissed, setJustDismissed] = useState<InboxCandidate | null>(null);
  const workspace = useAppStore((s) => s.config.current_workspace);

  const refreshCount = useCallback(async () => {
    setTotal(await kbInboxCount());
  }, []);

  const loadFirstBatch = useCallback(async () => {
    setLoading(true);
    setRows(await kbInboxList(BATCH, 0));
    setLoading(false);
  }, []);

  // 横幅计数无论展开与否都要拉（它就是入口）；候选列表只在展开后拉。
  // 工作区切换要重算：候选是按工作区隔离的。
  useEffect(() => {
    void refreshCount();
  }, [refreshCount, workspace]);

  useEffect(() => {
    if (expanded) void loadFirstBatch();
  }, [expanded, loadFirstBatch, workspace]);

  // 转完笔记回来：那条候选已经有笔记了，应该从虚拟视图里消失。
  useNoteDialogClosed(() => {
    void refreshCount();
    if (expanded) void loadFirstBatch();
  });

  const handleDismiss = useCallback(
    async (c: InboxCandidate) => {
      if (!(await kbInboxDismiss(c.item.id, c.reason))) return;
      // 本地先移除，立即给反馈；计数同步减一，不等一轮查询
      setRows((prev) => prev.filter((r) => r.item.id !== c.item.id));
      setTotal((n) => Math.max(0, n - 1));
      setJustDismissed(c);
    },
    [],
  );

  const handleUndo = useCallback(async () => {
    if (!justDismissed) return;
    if (!(await kbInboxUndismiss(justDismissed.item.id))) return;
    setJustDismissed(null);
    await refreshCount();
    if (expanded) await loadFirstBatch();
  }, [justDismissed, refreshCount, expanded, loadFirstBatch]);

  // 一条候选都没时整个横幅不出现——空面板比没面板更差
  if (total === 0 && !justDismissed) return null;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.banner}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Inbox size={13} className={styles.bannerIcon} />
        <span className={styles.bannerText}>
          待沉淀 <b>{total}</b> 条 —— 你反复找回过的内容
          {total > BATCH && <span className={styles.bannerHint}>，先看最相关的 {BATCH} 条</span>}
        </span>
        <ChevronDown
          size={13}
          className={`${styles.chevron}${expanded ? ` ${styles.chevronOpen}` : ""}`}
        />
      </button>

      {/* 忽略的撤销条。放在面板内而不是 toast：设计稿§5-4 要求本区永不弹 toast。 */}
      {justDismissed && (
        <div className={styles.undoBar}>
          <span className={styles.undoText}>已忽略「{cardLabel(justDismissed)}」</span>
          <button type="button" className={styles.undoBtn} onClick={() => void handleUndo()}>
            <Undo2 size={11} /> 撤销
          </button>
          <button
            type="button"
            className={styles.undoClose}
            onClick={() => setJustDismissed(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {expanded && (
        <div className={styles.list}>
          {loading && rows.length === 0 ? (
            <div className={styles.listEmpty}>正在加载…</div>
          ) : rows.length === 0 ? (
            <div className={styles.listEmpty}>这批已经处理完了。</div>
          ) : (
            rows.map((c) => <CandidateRow key={c.item.id} c={c} onDismiss={handleDismiss} />)
          )}
        </div>
      )}
    </div>
  );
}

/** 候选的短标题（撤销条用）。 */
function cardLabel(c: InboxCandidate): string {
  const first = (c.item.text || "").split("\n").find((l) => l.trim()) ?? "未命名内容";
  return first.trim().slice(0, 24);
}

function CandidateRow({
  c,
  onDismiss,
}: {
  c: InboxCandidate;
  onDismiss: (c: InboxCandidate) => Promise<void>;
}) {
  // 能不能转：复用 3️⃣ 那套抽取规则。file 卡片 / 无 OCR 的图片算不出初稿，
  // 就**不给按钮**而不是点了才报错（同右键菜单的口径）。
  const convertible = extractNoteDraft(c.item) !== null;

  return (
    <div className={styles.row}>
      <span className={`${styles.badge} ${c.reason === "star" ? styles.badgeStar : styles.badgeHit}`}>
        {c.reason === "star" ? <Star size={9} /> : <Search size={9} />}
        {c.reason === "star" ? "收藏" : `找回 ×${c.search_hit_count}`}
      </span>
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>{cardLabel(c) || "未命名内容"}</div>
        <div className={styles.rowSignal}>
          {signalText(c)}
          {c.recently_pasted && <span className={styles.pastedTag}>用过</span>}
        </div>
      </div>
      <div className={styles.rowActions}>
        {convertible ? (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => void openNoteForCard(c.item)}
          >
            转为笔记
          </button>
        ) : (
          <span className={styles.notConvertible} title="文件卡片与无识别文字的图片没有可写的正文">
            不支持转笔记
          </span>
        )}
        <button type="button" className={styles.ghostBtn} onClick={() => void onDismiss(c)}>
          忽略
        </button>
      </div>
    </div>
  );
}
