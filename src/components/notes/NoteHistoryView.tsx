/**
 * NoteHistoryView.tsx —— 版本历史视图（B1 #4 / D8）。
 *
 * 设计稿：design/PastePanda-版本快照-设计稿.html §2·丙：
 * **不叠弹窗、不开侧栏**，而是把编辑区换成它。480px 的窗口里只有这一种放得下，
 * 且弹窗与第三栏能用同一套代码。
 *
 * 两件它不管的事（在宿主）：未保存草稿的保留、恢复后把新内容写回编辑器状态。
 *
 * 🔴 红线：无 AI。快照只在本机 SQLite 与本组件之间走。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { relativeTime } from "@/lib/utils";
import {
  noteRevisionList,
  noteRevisionGet,
  noteRestore,
  type Note,
  type NoteRevisionMeta,
} from "@/lib/api";
import styles from "./NoteDialog.module.css";

/** 选中的是哪一行。`"current"` = 当前版（它不在 note_revisions 表里） */
type Selected = "current" | number;

export function NoteHistoryView({
  noteId,
  currentContent,
  currentUpdatedAt,
  isDirty,
  onBack,
  onRestored,
}: {
  noteId: string;
  /** 编辑器里的当前正文（可能含未保存的修改），用来预览「当前版」而不用再发 IPC */
  currentContent: string;
  /** 当前版的保存时间。弹窗那边拿不到（draft 只带编辑所需字段），所以可缺 */
  currentUpdatedAt?: string;
  isDirty: boolean;
  onBack: () => void;
  /** 恢复成功。宿主负责把新内容写回编辑器并切回编辑视图 */
  onRestored: (note: Note) => void;
}) {
  const { toast } = useToast();
  const [revs, setRevs] = useState<NoteRevisionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selected>("current");
  const [preview, setPreview] = useState("");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    void (async () => {
      setRevs(await noteRevisionList(noteId));
      setLoading(false);
    })();
  }, [noteId]);

  // 选中变化 → 拉那一份的全文。列表不带全文是故意的（见 api 注释），
  // 代价就是这里每点一行多一次 IPC。
  useEffect(() => {
    if (selected === "current") {
      setPreview(currentContent);
      return;
    }
    let alive = true;
    void (async () => {
      const rev = await noteRevisionGet(selected);
      if (alive) setPreview(rev?.content ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [selected, currentContent]);

  const handleRestore = useCallback(async () => {
    if (selected === "current") return;
    const ok = await confirmDialog({
      title: "恢复版本",
      // 脏数据必须写进去：恢复直接写库，草稿没地方去，不说就是静默丢数据。
      // （确认框是纯文本渲染，不要写 Markdown 星号）
      message: isDirty
        ? "把笔记恢复到这个版本？当前未保存的修改会丢失。原来已保存的内容会存成一份历史，可以再恢复回来。"
        : "把笔记恢复到这个版本？当前内容会存成一份历史，随时可以再恢复回来。",
      confirmText: "恢复",
    });
    if (!ok) return;
    setRestoring(true);
    const note = await noteRestore(selected);
    setRestoring(false);
    if (!note) return; // api 层已弹错（规则 #15.3），不重复提示也不关视图
    toast("已恢复，原版本已存入历史", "success");
    onRestored(note);
  }, [selected, isDirty, toast, onRestored]);

  return (
    <div className={styles.histWrap}>
      <div className={styles.histBar}>
        <button type="button" className={styles.histBack} onClick={onBack}>
          <ArrowLeft size={13} /> 返回编辑
        </button>
        <span className={styles.histCount}>
          {loading ? "读取中…" : `${revs.length} 份历史`}
        </span>
      </div>

      <div className={styles.histList}>
        {/* 当前版不在 note_revisions 里，但必须列出来：
            否则顶部那行看上去就像「现在的内容」，很容易认错。 */}
        <button
          type="button"
          className={`${styles.histRow} ${selected === "current" ? styles.histRowActive : ""}`}
          onClick={() => setSelected("current")}
        >
          <span className={styles.histWhen}>当前版本</span>
          <span className={styles.histNow}>● 现在</span>
          <span className={styles.histMeta}>
            {isDirty
              ? "有未保存修改"
              : currentUpdatedAt
                ? relativeTime(currentUpdatedAt)
                : "已保存"}
          </span>
        </button>

        {revs.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`${styles.histRow} ${selected === r.id ? styles.histRowActive : ""}`}
            onClick={() => setSelected(r.id)}
          >
            <span className={styles.histWhen}>{relativeTime(r.created_at)}</span>
            <span className={styles.histMeta}>{r.char_count} 字</span>
          </button>
        ))}

        {!loading && revs.length === 0 && (
          <div className={styles.histEmpty}>
            还没有历史版本。每次保存（且内容真的改了）会自动存一份，最多留 20 份。
          </div>
        )}
      </div>

      <pre className={styles.histPreview}>{preview}</pre>

      <div className={styles.histFooter}>
        <button
          type="button"
          className={styles.histRestore}
          onClick={() => void handleRestore()}
          disabled={selected === "current" || restoring}
          title={selected === "current" ? "这就是当前版本" : "恢复到选中的版本"}
        >
          <RotateCcw size={12} /> {restoring ? "恢复中…" : "恢复到这个版本"}
        </button>
      </div>
    </div>
  );
}
