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
import { ArrowLeft, RotateCcw, Pin, PinOff } from "lucide-react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { relativeTime } from "@/lib/utils";
import {
  noteRevisionList,
  noteRevisionGet,
  noteRevisionPin,
  noteRestore,
  type Note,
  type NoteRevisionMeta,
} from "@/lib/api";
import styles from "./NoteDialog.module.css";

/** 选中的是哪一行。`"current"` = 当前版（它不在 note_revisions 表里） */
type Selected = "current" | number;

/**
 * `agent:claude-code` → `claude-code`。空串 = 人工编辑，调用方不渲染。
 *
 * 显示具体客户端名而不统一写「模型改」：接了多个客户端时还分得出是哪个，
 * 且与 W3 调用记录里的名字对得上。
 */
function agentLabel(source: string): string {
  return source.startsWith("agent:") ? source.slice(6) : source;
}

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
  const [pinning, setPinning] = useState(false);

  const reload = useCallback(async () => {
    setRevs(await noteRevisionList(noteId));
  }, [noteId]);

  useEffect(() => {
    void (async () => {
      await reload();
      setLoading(false);
    })();
  }, [reload]);

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

  // 选中的那一行。当前版不在快照表里，所以它没有对应行也就无物可锚。
  const selectedRev =
    selected === "current" ? null : (revs.find((r) => r.id === selected) ?? null);
  const pinnedCount = revs.filter((r) => r.pinned).length;

  const handleTogglePin = useCallback(async () => {
    if (!selectedRev) return;
    const next = !selectedRev.pinned;
    // 只有「解除」才确认：加锚只会多保留一份，没有可后悔的后果。
    // 解除的后果是**延迟**的，不写清楚的话用户看到的就是
    // 「点了没反应，过一阵它自己不见了」。（确认框是纯文本，不写 Markdown 星号）
    if (!next) {
      const ok = await confirmDialog({
        title: "解除锚定",
        message:
          "解除后这一份不会立即消失，但会重新参与 20 份上限排队，后继编辑够多时会被挤掉。",
        confirmText: "解除",
      });
      if (!ok) return;
    }
    setPinning(true);
    const done = await noteRevisionPin(selectedRev.id, next);
    setPinning(false);
    // 失败时不动 UI（api 层已弹错，规则 #15.3）：否则显示在保护，实际没有。
    if (!done) return;
    await reload();
    toast(next ? "已锚定，这一份不会被挤掉" : "已解除锚定", "success");
  }, [selectedRev, reload, toast]);

  return (
    <div className={styles.histWrap}>
      <div className={styles.histBar}>
        <button type="button" className={styles.histBack} onClick={onBack}>
          <ArrowLeft size={13} /> 返回编辑
        </button>
        <span className={styles.histCount}>
          {loading
            ? "读取中…"
            : pinnedCount > 0
              ? `${revs.length} 份历史 · ${pinnedCount} 份锚定`
              : `${revs.length} 份历史`}
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
            {/* 保持时间倒序、不把锚定份置顶：历史就是按时间读的，
                切成两段反而难定位。只给一个徽标。 */}
            {r.pinned && <span className={styles.histPin}>锚定</span>}
            {r.source_agent && (
              <span className={styles.histSrc}>{agentLabel(r.source_agent)} 改</span>
            )}
            <span className={styles.histMeta}>{r.char_count} 字</span>
          </button>
        ))}

        {!loading && revs.length === 0 && (
          <div className={styles.histEmpty}>
            还没有历史版本。每次保存（且内容真的改了）会自动存一份，最多留 20
            份；锚定的那一份不占这 20 份。
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

        {/* 当前版不显示锚定按钮（它不在快照表里）。也不做成行内悬停按钮——
            历史行本身就是 <button>，里面再嵌按钮是非法 HTML。 */}
        {selectedRev && (
          <button
            type="button"
            className={styles.histPinBtn}
            onClick={() => void handleTogglePin()}
            disabled={pinning}
            title={
              selectedRev.pinned
                ? "解除锚定：这一份将重新参与 20 份上限排队"
                : "锚定：这一份永不被 20 份上限挤掉"
            }
          >
            {selectedRev.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            {selectedRev.pinned ? "解除锚定" : "锚定"}
          </button>
        )}
      </div>
    </div>
  );
}
