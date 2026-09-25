/**
 * 岛的展开态：头（标题 + 进行中/已完成切换 + 收起）+ 列表 + 底（记一条 / 输入行）。
 *
 * 结构与设计稿 S3（420×240 列表）/ S4（420×280 输入）一致；只从 `TodoIsland`
 * 的舞台机器里拆出来（规则 #7：单文件 300 行红线）。
 *
 * ## 写回与乐观更新（B3）
 *
 * 点勾圈 → 本地把这一行翻面（乐观），同时 `toggleTask` 走 Rust 的
 * `note_update` 写库；成功后 Rust 广播新状态，与本地翻面**一致时丢弃**乐观标记。
 * 失败（行号漂移 / 笔记没了）→ 丢弃乐观标记；Rust 在失败路径也会把库里的
 * 真实现状推过来（`todo_island_toggle_task` 的自愈分支），UI 随之回到真实。
 * 错误**必须可见**（规则 #15.3）：底栏提示位显示一句、几秒后自行退场。
 */
import { useEffect, useRef, useState } from "react";
import { addTask, toggleTask } from "@/lib/todo/islandBridge";
import type { IslandState, IslandTask } from "@/lib/todo/types";
import styles from "./TodoIsland.module.css";

/** 乐观翻面标记的键：一篇笔记同一行只会有一条任务 */
const taskKey = (t: IslandTask) => `${t.noteId}:${t.line}`;

/** 勾选图标的路径——列表行与全清态同一份（设计稿修正 #2：同一语义不许两套实现） */
function TickSvg() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M3 8.5l3.4 3.4L13 5" />
    </svg>
  );
}

interface Props {
  state: IslandState;
  /** true = 输入态（compose，420×280）：底栏换成输入行 */
  compose: boolean;
  onCollapse: () => void;
  onComposeOpen: () => void;
}

export function TodoIslandList({ state, compose, onCollapse, onComposeOpen }: Props) {
  const [tab, setTab] = useState<"open" | "done">("open");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [flips, setFlips] = useState<Map<string, boolean>>(new Map());
  const noticeTimer = useRef<number | undefined>(undefined);

  const applyFlip = (t: IslandTask): IslandTask =>
    flips.get(taskKey(t)) === undefined ? t : { ...t, done: flips.get(taskKey(t)) as boolean };

  const rows = tab === "open" ? state.tasks.map(applyFlip) : state.doneTasks.map(applyFlip);

  // 服务器状态已体现翻面（或那条任务消失了）→ 乐观标记完成使命，丢掉
  useEffect(() => {
    setFlips((prev) => {
      const all = [...state.tasks, ...state.doneTasks];
      const next = new Map(prev);
      for (const [k, v] of prev) {
        const t = all.find((x) => taskKey(x) === k);
        if (!t || t.done === v) next.delete(k);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [state]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const flashNotice = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  };

  const onTick = (t: IslandTask) => {
    const target = !t.done;
    setFlips((prev) => new Map(prev).set(taskKey(t), target));
    toggleTask(t).catch(() => {
      setFlips((prev) => {
        const n = new Map(prev);
        n.delete(taskKey(t));
        return n;
      });
      // Rust 失败路径会推送库里的真实现状（自愈）；这里只负责把「没勾上」说出口
      flashNotice("这条待办刚被其它途径改过，已还原");
    });
  };

  const onAdd = () => {
    const body = text.trim();
    if (!body) return;
    addTask(body)
      .then(() => {
        setText("");
        setNotice(null);
      })
      .catch(() => flashNotice("没记上，再试一次"));
  };

  const pendingCount = Math.max(0, state.total - state.done);

  return (
    <>
      <div className={styles.hd}>
        <span className={styles.title}>{pendingCount} 项待办</span>
        <span className={styles.seg} role="tablist" aria-label="待办视图">
          <span
            role="tab"
            aria-selected={tab === "open"}
            className={tab === "open" ? styles.on : undefined}
            onClick={() => setTab("open")}
          >
            进行中
          </span>
          <span
            role="tab"
            aria-selected={tab === "done"}
            className={tab === "done" ? styles.on : undefined}
            onClick={() => setTab("done")}
          >
            已完成
          </span>
        </span>
        <button className={styles.col} title="收起" aria-label="收起" onClick={onCollapse}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
      </div>

      <div className={styles.ls} role="list">
        {rows.length === 0 ? (
          <div className={styles.empty}>
            {tab === "open" ? (
              <>
                <p>没有进行中的待办</p>
                <p className={styles.emptySub}>点下方「记一条」加一条，或在笔记里写 - [ ] 待办内容</p>
              </>
            ) : (
              <>
                <p>还没有勾完的待办</p>
                <p className={styles.emptySub}>勾掉「进行中」里的一条，它会出现在这里</p>
              </>
            )}
          </div>
        ) : (
          rows.map((t) => (
            <div key={taskKey(t)} className={`${styles.row} ${t.done ? styles.rowDone : ""}`} role="listitem">
              <button
                className={styles.tick}
                title={t.done ? "标记为未完成" : "完成"}
                aria-label={t.done ? "标记为未完成" : "完成"}
                onClick={() => onTick(t)}
              >
                <span className={styles.tickDot}>
                  <TickSvg />
                </span>
              </button>
              <span className={styles.tx}>{t.text}</span>
              <span className={styles.src}>{t.noteTitle}</span>
            </div>
          ))
        )}
      </div>

      {notice ? (
        <div className={styles.notice} role="alert">
          {notice}
        </div>
      ) : null}

      {compose ? (
        <div className={styles.foot}>
          <input
            className={styles.cinput}
            value={text}
            placeholder="要做什么？"
            aria-label="记一条待办"
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAdd();
            }}
          />
          <span className={styles.footHint}>回车记下</span>
        </div>
      ) : (
        <button className={styles.foot} onClick={onComposeOpen}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          <span>记一条</span>
        </button>
      )}
    </>
  );
}
