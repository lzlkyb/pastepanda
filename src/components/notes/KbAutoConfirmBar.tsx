import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { noteListAuto, noteConfirmAuto, noteCountAuto } from "@/lib/api";
import type { Note } from "@/lib/api";
import styles from "./KbAutoConfirmBar.module.css";

/**
 * 知识库顶部那条「自动沉淀了 N 篇草稿」（「文章 → 知识库」阶段 3）。
 *
 * # 形状照抄 `KbHealthBar`
 *
 * 知识库顶部「只在有话说时才出现」的状态条。展开后列出草稿标题，
 * 点标题打开笔记——逐篇的「转正 / 删除」在笔记右键菜单里
 * （`useNoteMenu`：auto_deposited 的笔记多一项「转正草稿」；丢弃 = 删除笔记，
 * 本来就是软删进回收站，不另造第二份真相）。
 *
 * # 全好时返 null
 *
 * 没有待确认草稿就不占一行（AM-8 口径：只在真有事时占字）。
 *
 * # 计数对账
 *
 * store 里的 `autoDepositCount` 是增量账（沉淀 +1 / 转正 -1），本组件挂载
 * 与 `version` 变化时用 `noteCountAuto()` 对一次账——增量账在跨视图操作、
 * 回收站恢复等边角下会漂，权威数永远在后端。
 *
 * # 样式全在 CSS Module 里（U8），类名与 KbHealthBar 一一对应。
 */
export function KbAutoConfirmBar({
  version,
  onOpenNote,
  onChanged,
}: {
  /** 笔记增删改的版本号；变了就对账。不做定时轮询（同 KbHealthBar）。 */
  version: number;
  onOpenNote: (id: string) => void;
  /** 批量转正后让父级重拉列表。 */
  onChanged: () => void;
}) {
  const count = useAppStore((s) => s.autoDepositCount);
  const setAutoDepositCount = useAppStore((s) => s.setAutoDepositCount);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [drafts, setDrafts] = useState<Note[]>([]);
  const [busy, setBusy] = useState(false);

  const reconcile = useCallback(() => {
    void noteCountAuto().then((n) => setAutoDepositCount(n));
  }, [setAutoDepositCount]);

  useEffect(() => {
    reconcile();
  }, [version, reconcile]);

  // 展开时才拉草稿列表：折叠态不为明细花 IPC
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    void noteListAuto().then((rows) => {
      if (alive) setDrafts(rows);
    });
    return () => {
      alive = false;
    };
  }, [expanded, version]);

  const confirmAll = useCallback(async () => {
    setBusy(true);
    try {
      const rows = await noteListAuto();
      let failed = 0;
      for (const row of rows) {
        if (!(await noteConfirmAuto(row.id))) failed += 1;
      }
      if (failed > 0) {
        // 有失败就不清零：让对账 effect 拿后端的权威数把条数修正
        reconcile();
      } else {
        setAutoDepositCount(0);
        setDrafts([]);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [onChanged, reconcile, setAutoDepositCount]);

  /** 逐条转正（行内按钮）：成功就从本地列表摘掉 + 计数 -1，不用重拉。 */
  const confirmOne = useCallback(
    async (id: string) => {
      if (!(await noteConfirmAuto(id))) return;
      setDrafts((rows) => rows.filter((r) => r.id !== id));
      setAutoDepositCount(useAppStore.getState().autoDepositCount - 1);
      onChanged();
    },
    [onChanged, setAutoDepositCount],
  );

  if (dismissed || count <= 0) return null;

  return (
    <div className={styles.bar}>
      <div className={styles.status}>
        <span className={styles.dot} />
        <span className={styles.statusText}>
          自动沉淀了 <b>{count}</b> 篇草稿
          <span className={styles.muted}>（点亮星标的卡片已自动转文，等你确认）</span>
        </span>
        <button
          type="button"
          className={styles.confirmAllBtn}
          onClick={() => void confirmAll()}
          disabled={busy}
        >
          {busy ? "转正中…" : "转正全部"}
        </button>
        <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起 ▴" : "逐篇看 ▾"}
        </button>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          title="本次不再提示（草稿仍在列表里）"
          aria-label="本次不再提示"
        >
          ×
        </button>
      </div>

      {expanded && (
        <div className={styles.detail}>
          {drafts.length === 0 && <span>列表拉取中…</span>}
          {drafts.slice(0, 5).map((d) => (
            <span key={d.id} className={styles.item}>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => onOpenNote(d.id)}
                title={d.title || "（无标题）"}
              >
                {d.title || "（无标题）"}
              </button>
              <span className={styles.itemTitle} aria-hidden="true" />
              <button type="button" className={styles.confirmAllBtn} onClick={() => void confirmOne(d.id)}>
                转正
              </button>
            </span>
          ))}
          {drafts.length > 5 && (
            <span className={styles.muted}>（还有 {drafts.length - 5} 篇未列出）</span>
          )}
          {/* 指导语只说一次：逐条重复会把明细区变成噪声（V7） */}
          <span className={styles.muted}>
            点标题打开编辑；「转正」收下；丢弃 = 打开后删笔记（进回收站，可撤销）
          </span>
        </div>
      )}
    </div>
  );
}
