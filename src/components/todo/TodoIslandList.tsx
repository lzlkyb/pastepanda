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
 *
 * ## 失败提示为什么不在本组件里（规则 §15.1 / §15.3）
 *
 * 勾选/输入的失败可能发生在**列表正要收起的那一刻**。提示若挂在列表内部，
 * 会随列表一起被卸载——用户点了没反应，还查不到原因。所以本组件只负责
 * `onNotice` 上报，展示位置由父级按当前舞台决定（列表态浮在列表底部，
 * 折叠态占住胶囊那一格文字）。
 */
import { useEffect, useRef, useState } from "react";
import { addTask, toggleTask } from "@/lib/todo/islandBridge";
import type { IslandState, IslandTask } from "@/lib/todo/types";
import styles from "./TodoIsland.module.css";

/** 乐观翻面标记的键：一篇笔记同一行只会有一条任务 */
const taskKey = (t: IslandTask) => `${t.noteId}:${t.line}`;

/** 勾选后行退场的时长：圈先变色（≤150ms 有反馈），行再走（≤200ms 离场）。
 *  与 CSS `.rowLeave` 的 150ms 过渡配一套——改这里必须同步那边。 */
const LEAVE_AFTER_MS = 200;

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
  /** 输入草稿挂岛层（受控）：自动收起要判断「有没打完的字」，收起不销毁草稿 */
  composeText: string;
  onComposeText: (s: string) => void;
  onCollapse: () => void;
  onComposeOpen: () => void;
  /** 失败提示上报（null = 清除）。自退场计时在父级，这里只管说出口。 */
  onNotice: (msg: string | null) => void;
}

export function TodoIslandList({
  state,
  compose,
  composeText,
  onComposeText,
  onCollapse,
  onComposeOpen,
  onNotice,
}: Props) {
  const [tab, setTab] = useState<"open" | "done">("open");
  const [flips, setFlips] = useState<Map<string, boolean>>(new Map());
  /** 已翻成完成、正在退场的行：等退场动画放完才从 DOM 摘掉 */
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const leaveTimers = useRef<Map<string, number>>(new Map());

  const applyFlip = (t: IslandTask): IslandTask =>
    flips.get(taskKey(t)) === undefined ? t : { ...t, done: flips.get(taskKey(t)) as boolean };

  // 退场中的行不占位：圈先变色、行再走，两个反馈分开，用户看得出刚勾的是哪一条。
  // ❗ 只对「进行中」生效：同一批 key 也可能刚从「已完成」里被取消勾选，
  //    那边是要正常显示的行；误过滤会把用户刚改完的行变没了。
  const rows = (tab === "open" ? state.tasks : state.doneTasks)
    .map(applyFlip)
    .filter((t) => tab !== "open" || !leaving.has(taskKey(t)));

  /** 取消某行的退场（撤销勾选 / 写回失败都要用）：计时器和状态一起清 */
  const cancelLeave = (key: string) => {
    const timer = leaveTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      leaveTimers.current.delete(key);
    }
    setLeaving((prev) => {
      if (!prev.has(key)) return prev;
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
  };

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
    // 退场标记跟着服务器现状收敛：这条已经不在「进行中」里（已归档 / 被删 /
    // 被外部改回去）就不该再挂着——否则它哪天回来会被静默藏掉。
    setLeaving((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(state.tasks.map(taskKey));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [state]);

  // 岛收起时本组件会被卸载，没跑的退场计时器不能留着
  useEffect(
    () => () => {
      leaveTimers.current.forEach((id) => window.clearTimeout(id));
      leaveTimers.current.clear();
    },
    [],
  );

  const onTick = (t: IslandTask) => {
    const target = !t.done;
    const key = taskKey(t);
    setFlips((prev) => new Map(prev).set(key, target));
    if (!target) {
      // 取消完成：行哪儿也不去
      cancelLeave(key);
    } else {
      const timer = window.setTimeout(() => {
        leaveTimers.current.delete(key);
        setLeaving((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      }, LEAVE_AFTER_MS);
      leaveTimers.current.set(key, timer);
    }
    toggleTask(t).catch(() => {
      // 失败：翻面作废 + 退场取消，行回到列表原位的未完成态
      cancelLeave(key);
      setFlips((prev) => {
        const n = new Map(prev);
        n.delete(key);
        return n;
      });
      // Rust 失败路径会推送库里的真实现状（自愈）；这里只负责把「没勾上」说出口
      onNotice("这条待办刚被其它途径改过，已还原");
    });
  };

  const onAdd = () => {
    const body = composeText.trim();
    if (!body) return;
    addTask(body)
      .then(() => {
        onComposeText("");
        onNotice(null);
      })
      .catch(() => onNotice("没记上，再试一次"));
  };

  const pendingCount = Math.max(0, state.total - state.done);

  /** 到期 chip 的文案与档位：过期红、今天蓝、未来灰。已完成的不再说「已过期」 */
  const dueChip = (t: IslandTask) => {
    if (!t.dueMs || !t.dueLabel) return null;
    const over = !t.done && t.dueMs < Date.now();
    const today = !over && (t.dueLabel.startsWith("今天") || t.dueLabel.startsWith("明天"));
    return {
      text: over ? `已过期 · ${t.dueLabel}` : t.dueLabel,
      cls: over ? styles.duechipOver : today ? styles.duechipToday : styles.duechip,
    };
  };

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
        <button className={styles.col} title="收起（Esc）" aria-label="收起" onClick={onCollapse}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 10l4-4 4 4" />
          </svg>
          {/* L2：文字常驻，快捷键只进 title（hover 是加速器，不是唯一线索） */}
          <span>收起</span>
        </button>
      </div>

      <div className={styles.ls} role="list">
        {rows.length === 0 ? (
          <div className={styles.empty}>
            {tab === "open" ? (
              <>
                <p>没有进行中的待办</p>
                <p className={styles.emptySub}>点下方「记一条」加一条，或在笔记里写 - [ ] 待办内容；时间写尾部（如 @今天 18:00）会到点提醒</p>
              </>
            ) : (
              <>
                <p>还没有勾完的待办</p>
                <p className={styles.emptySub}>勾掉「进行中」里的一条，它会出现在这里</p>
              </>
            )}
          </div>
        ) : (
          rows.map((t) => {
            const chip = dueChip(t);
            return (
              <div
                key={taskKey(t)}
                className={`${styles.row} ${t.done ? styles.rowDone : ""} ${leaving.has(taskKey(t)) ? styles.rowLeave : ""}`}
                role="listitem"
              >
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
                {chip ? <span className={chip.cls}>{chip.text}</span> : null}
                <span className={styles.src}>{t.noteTitle}</span>
              </div>
            );
          })
        )}
      </div>

      {compose ? (
        <div className={styles.foot}>
          <input
            className={styles.cinput}
            value={composeText}
            placeholder="要做什么？加 @明天 18:00 可到点提醒"
            aria-label="记一条待办"
            autoFocus
            onChange={(e) => onComposeText(e.target.value)}
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