/**
 * 回收站面板（W1 / 知识模式中栏）。设计稿：design/知识库回收站-W1-设计稿.html
 *
 * 为什么不复用 `NoteList`：两者只有「一行一条笔记」长得像，行为没一样——
 * 不能点开编辑器、时间列是 `deleted_at`、行尾是两个动作、没有搜索/分组/筛选。
 * 强行复用只会给 `NoteList` 加上一堆 `isTrash &&` 分支。
 *
 * ❗ **不提供进编辑器的路径**。编辑器会自动保存，而 `note_update` 带
 *   `AND deleted_at IS NULL`，已删的笔记一改就报「笔记不存在」——
 *   后端拦得住，但用户看到的是「我刚改的东西报错了」。想改就先恢复。
 *
 * 倒计时在这里算，不为它动接口：`deleted_at` 已经返回了，天数读配置。
 *
 * 🔴 红线：无 AI。
 */
import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import {
  noteListDeleted,
  noteRestoreDeleted,
  notePurge,
  notePurgeAll,
  type Note,
} from "@/lib/api/notes";
import { confirmDialog } from "@/lib/confirm";
import { relativeTime } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { excerpt } from "./NoteList";
import styles from "../KnowledgeView.module.css";
/** 只读预览最多渲染多少行。回收站只需要「认出是哪条」，不是阅读器。 */
const PREVIEW_LINES = 30;

/**
 * 还剩多少天被自动销毁。`days <= 0`（用户关了自动清理）返回 `null`。
 *
 * ❗ 这个倒计时不是锦上添花，它是 30 天方案成立的前提：不显示的话，
 * 用户在第 31 天想找回某条时看到的是个空回收站、没任何痕迹说明发生过什么，
 * 那就从「安全网」变成了「背着人销毁数据」。
 *
 * 后端的判定是 `deleted_at < now - days`（严格小于），这里向上取整保持一致：
 * 宁可显示「还有 1 天」而实际已经过期一点点，也不能显示「还有 0 天」却还没删。
 */
function daysLeft(deletedAt: string | null | undefined, days: number): number | null {
  if (!deletedAt || days <= 0) return null;
  // deleted_at 是本地时间字符串 `YYYY-MM-DD HH:mm:ss.SSS`，Safari 以外的引擎
  // 直接 new Date() 解不了带空格的形式，换成 `T` 才稳（Tauri 是 WebView2，
  // 但这里不依赖引擎的宽容处理）。
  const t = new Date(deletedAt.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return null;
  const elapsed = (Date.now() - t) / 86_400_000;
  return Math.max(0, Math.ceil(days - elapsed));
}

/** 剩余 ≤ 3 天就不能只给个数字，得把后果说出来。 */
function expiryText(left: number | null): { text: string; urgent: boolean } | null {
  if (left === null) return null;
  if (left <= 3) return { text: `还有 ${left} 天就自动删除`, urgent: true };
  return { text: `还有 ${left} 天`, urgent: false };
}
export function TrashPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Note[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const days = useAppStore((s) => s.config.note_trash_days);

  const reload = useCallback(async () => {
    setLoading(true);
    setRows(await noteListDeleted());
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRestore = useCallback(
    async (n: Note) => {
      // 不弹确认：恢复是可逆的（再删一次就回来了），加确认只是噪音。
      // 失败时 noteRestoreDeleted 已经把后端的人话错误 toast 出去了
      // （速记撞日期那条），这里千万不要再盖一个笼统的「恢复失败」。
      if (!(await noteRestoreDeleted(n.id, n.history_id))) return;
      await reload();
      onChanged?.();
    },
    [reload, onChanged],
  );

  const handlePurge = useCallback(
    async (n: Note) => {
      // 历史份数在这一刻才取：列表接口不带它，也不该为一个低频确认框污染列表。
      const { noteRevisionList } = await import("@/lib/api/noteRevisions");
      const revs = await noteRevisionList(n.id);
      const title = n.title.trim() || "无标题";
      // 文案必须带具体数字：confirmDialog 只吃纯字符串，后果只能靠句子本身说清楚，
      // 泛泛的「相关内容将被删除」用户无法据以决策（同 folder_delete_impact 的口径）。
      const tail = revs.length > 0 ? `与它的 ${revs.length} 份历史版本` : "";
      const ok = await confirmDialog({
        title: "彻底删除这条笔记？",
        message: `「${title}」${tail}将被永久删除，无法撤销。`,
        confirmText: "彻底删除",
        variant: "danger",
      });
      if (!ok || !(await notePurge(n.id))) return;
      await reload();
    },
    [reload],
  );

  const handlePurgeAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: "清空回收站？",
      message: `${rows.length} 条笔记与它们的全部历史版本将被永久删除，无法撤销。`,
      confirmText: "清空",
      variant: "danger",
    });
    if (!ok || (await notePurgeAll()) === null) return;
    await reload();
  }, [rows.length, reload]);

  if (loading) return null;
  if (rows.length === 0) {
    return (
      <div className={styles.trashEmpty}>
        <p>回收站是空的</p>
        <p className={styles.trashEmptyHint}>删掉的笔记会先放到这里</p>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {/* 回收站不走 KnowledgeToolbar（那里的搜索/分组/筛选/新建在这里都无意义），
          所以标题与条数得自己给——否则用户进来后不知道自己在哪。 */}
      <li className={styles.trashHead}>
        <b className={styles.trashTitle}>回收站</b>
        <span className={styles.trashHint}>{rows.length} 条・</span>
        <span className={styles.trashHint}>
          {days > 0
            ? `删除的笔记在这里保留 ${days} 天，到期自动销毁`
            : "删除的笔记一直保留在这里，不会自动清理"}
        </span>
        <button type="button" className={styles.trashClear} onClick={() => void handlePurgeAll()}>
          清空回收站
        </button>
      </li>
      {rows.map((n) => {
        const open = expanded === n.id;
        const exp = expiryText(daysLeft(n.deleted_at, days));
        return (
          <li key={n.id} className={styles.trashRow}>
            {/* 整行只负责展开/收起，**不进编辑器**（见文件头部） */}
            <button
              type="button"
              className={styles.rowMain}
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : n.id)}
            >
              <span className={styles.rowTitle}>
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {n.title.trim() || "无标题"}
              </span>
              <span className={styles.rowExcerpt}>
                {n.content.trim() ? excerpt(n.content) : "（空笔记）"}
              </span>
              <span className={styles.rowMeta}>
                <span className={styles.rowTime}>删于 {relativeTime(n.deleted_at ?? "")}</span>
                {n.daily_date && <span className={styles.rowFolder}>速记</span>}
                {exp && (
                  <span className={exp.urgent ? styles.trashExpiryUrgent : styles.trashExpiry}>
                    {exp.text}
                  </span>
                )}
              </span>
            </button>
            {open && (
              <pre className={styles.trashPreview}>
                {n.content.split("\n").slice(0, PREVIEW_LINES).join("\n") || "（空笔记）"}
              </pre>
            )}
            <div className={styles.trashActions}>
              <button
                type="button"
                className={styles.trashRestore}
                title="恢复"
                onClick={() => void handleRestore(n)}
              >
                <RotateCcw size={12} /> 恢复
              </button>
              <button
                type="button"
                className={styles.trashPurge}
                title="彻底删除"
                onClick={() => void handlePurge(n)}
              >
                <Trash2 size={12} /> 彻底删除
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
