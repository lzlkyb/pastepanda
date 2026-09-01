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
import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, Inbox, Star, Search, Undo2 } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { relativeTime } from "@/lib/utils";
import { extractNoteDraft } from "@/lib/notes/extract";
import { openNoteForCard } from "@/lib/notes/open";
import {
  kbInboxList,
  kbInboxCount,
  kbInboxGroupCounts,
  kbInboxDismiss,
  kbInboxUndismiss,
  type InboxCandidate,
} from "@/lib/api";
import { CONTENT_TYPE_META, getContentTypeMeta } from "@/lib/contentTypes";
import {
  DEFAULT_INBOX_VIEW,
  INBOX_GROUPS,
  INBOX_SORTS,
  groupHeaderFor,
  inboxViewChips,
  type InboxViewOpts,
} from "@/lib/notes/viewOpts";
import { ViewControls, ViewChips, TriRow } from "./ViewControls";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import styles from "./KbInboxPanel.module.css";

/** 首屏与每批条数。设计稿 §5-2b 定的 20。 */
const BATCH = 20;

/** 类型多选的全部候选项。走卡片类型徽用的同一份映射（规则 #11）。 */
const TYPE_OPTIONS = Object.entries(CONTENT_TYPE_META).map(([key, meta]) => ({
  key,
  label: meta.label,
}));

/** 信号说明行。
 *
 * ❗ **比设计稿少一句「最近一次在今天 14:32」**。
 *   原因变了，结论暂时没变：`history.search_hit_at` 已于 2026-09-01 落库（A-44），
 *   但**还没暴露到 `HistoryItem`**（那一步有意留给 #7 / #2），而且刚落库时全是 NULL。
 *   编一个时间比不写更糟；同理收藏也没有「收藏时间」（`pinned` 就是个布尔）。
 *   能说的只有采集时间，就只说它。
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

  /** 字段视图（B2 #9）。同笔记侧：**不持久化**，筛选是一次性意图不是偏好。 */
  const [view, setView] = useState<InboxViewOpts>(DEFAULT_INBOX_VIEW);
  /** 组头的**真实**条数（后端 GROUP BY） */
  const [groupCounts, setGroupCounts] = useState<Map<string, number>>(new Map());
  const [loadingMore, setLoadingMore] = useState(false);

  const patchView = useCallback((patch: Partial<InboxViewOpts>) => {
    setView((cur) => ({ ...cur, ...patch }));
  }, []);

  /**
   * 组名→显示名。
   *
   * 后端回的是**原始值**（`code` / `Chrome` / `star`），中文映射在前端：
   * `content_type` → 中文那份 19 项的表就住在 `CONTENT_TYPE_META`（卡片类型徽用的同一份），
   * 在 Rust 里再写一份两边早晚对不上（规则 #11）。
   * 笔记侧相反——那边组名（文件夹名 / 标签名）本来就存在库里，直接算成显示串更便宜。
   */
  const groupLabel = useCallback(
    (key: string) => {
      if (view.groupBy === "type") return getContentTypeMeta(key).label;
      if (view.groupBy === "reason") return key === "star" ? "收藏" : "找回";
      // 按来源分组：没来源的卡片 source 是空串（非 NULL），组名得自己补
      return key || "（无来源）";
    },
    [view.groupBy],
  );

  const refreshCount = useCallback(async () => {
    // 带 view：否则横幅说 225 条而筛选后的列表里只有 12 条
    setTotal(await kbInboxCount(view));
  }, [view]);

  const loadFirstBatch = useCallback(async () => {
    setLoading(true);
    const [list, groups] = await Promise.all([
      kbInboxList(BATCH, 0, view),
      kbInboxGroupCounts(view),
    ]);
    setRows(list);
    setGroupCounts(groups);
    setLoading(false);
  }, [view]);

  /**
   * 加载更多。本面板原本也只拉首批 20 条，只是它在横幅上写了「先看最相关的 20 条」
   * ——诚实，但剩下的看不到。分组下更不行：组头会写着真实条数而组里只摆得出几条。
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    const more = await kbInboxList(BATCH, rows.length, view);
    setRows((cur) => [...cur, ...more]);
    setLoadingMore(false);
  }, [loading, loadingMore, rows.length, view]);

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
          {/* 字段视图控件（B2 #9）。本面板没有搜索行，所以自己开一行——
              但它**只在展开后出现**，收起状态仍然只是一条横幅 */}
          <div className={styles.viewBar}>
            <ViewControls
              sort={{
                options: INBOX_SORTS,
                value: view.sort,
                onChange: (v) => patchView({ sort: v as InboxViewOpts["sort"] }),
              }}
              group={{
                options: INBOX_GROUPS,
                value: view.groupBy,
                onChange: (v) => patchView({ groupBy: v as InboxViewOpts["groupBy"] }),
              }}
              filterActive={!!(view.reason || view.pasted || view.types.length)}
              filterPanel={
                <>
                  <TriRow
                    label="粘贴过"
                    value={view.pasted}
                    yesText="用过"
                    noText="没用过"
                    onChange={(v) => patchView({ pasted: v })}
                  />
                  <div className={styles.filterLabel}>入选原因</div>
                  <div className={styles.typeGrid}>
                    {[
                      { v: "" as const, t: "不筛" },
                      { v: "star" as const, t: "收藏" },
                      { v: "research" as const, t: "找回" },
                    ].map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        className={`${styles.typeChip}${view.reason === o.v ? ` ${styles.typeOn}` : ""}`}
                        onClick={() => patchView({ reason: o.v })}
                      >
                        {o.t}
                      </button>
                    ))}
                  </div>
                  <div className={styles.filterLabel}>
                    内容类型（多选 = 并集）
                  </div>
                  <div className={styles.typeGrid}>
                    {TYPE_OPTIONS.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        className={`${styles.typeChip}${
                          view.types.includes(t.key) ? ` ${styles.typeOn}` : ""
                        }`}
                        onClick={() =>
                          patchView({
                            types: view.types.includes(t.key)
                              ? view.types.filter((x) => x !== t.key)
                              : [...view.types, t.key],
                          })
                        }
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </>
              }
            />
          </div>
          <ViewChips
            chips={inboxViewChips(view, patchView, (t) => getContentTypeMeta(t).label)}
            onClearAll={() => setView(DEFAULT_INBOX_VIEW)}
          />

          {loading && rows.length === 0 ? (
            <div className={styles.listEmpty}>正在加载…</div>
          ) : rows.length === 0 ? (
            <div className={styles.listEmpty}>这批已经处理完了。</div>
          ) : (
            <>
              {rows.map((c, i) => {
                const header = groupHeaderFor(rows, i);
                return (
                  <Fragment key={c.item.id}>
                    {header !== null && (
                      <div className={styles.groupHead}>
                        <span>{groupLabel(header)}</span>
                        {groupCounts.has(header) && (
                          <span className={styles.groupCount}>{groupCounts.get(header)} 条</span>
                        )}
                      </div>
                    )}
                    <CandidateRow c={c} onDismiss={handleDismiss} />
                  </Fragment>
                );
              })}
              <LoadMoreSentinel
                hasMore={rows.length < total}
                loading={loadingMore}
                onLoadMore={() => void loadMore()}
                className={styles.loadMore}
              />
            </>
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
