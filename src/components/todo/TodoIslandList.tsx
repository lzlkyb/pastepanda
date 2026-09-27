/**
 * 岛的展开态：头（标题 + 进行中/已完成切换 + 收起）+ 列表 + 底（记一条 / 输入行）。
 *
 * 结构与设计稿 S3（420×240 列表）/ S4（420×280 输入）一致；只从 `TodoIsland`
 * 的舞台机器里拆出来（规则 #7：单文件 300 行红线）。
 *
 * ## 交互（2026-09-27 critique 落地）
 * - **整行可点 = 勾/取消勾**（B 方案）：命中面从 24×24 勾圈扩到全行；来源笔记名
 *   `.src` 拦冒泡不参与——预留给「打开笔记」。写回状态机（乐观翻面 / 6s 完成态
 *   驻留 / 撤销 chip / 退场）在 `useIslandTaskOps`，这里只管渲染与转发。
 * - **tab 是真按钮**（P1-1）：`role="tab"` + roving tabindex，←/→ 可切换；
 *   焦点环见 module.css 的 :focus-visible 组。
 *
 * ## 失败提示为什么不在本组件里（规则 §15.1 / §15.3）
 *
 * 勾选/输入的失败可能发生在**列表正要收起的那一刻**。提示若挂在列表内部，
 * 会随列表一起被卸载——用户点了没反应，还查不到原因。所以本组件只负责
 * `onNotice` 上报，展示位置由父级按当前舞台决定（列表态浮在列表底部，
 * 折叠态占住胶囊那一格文字）。
 */
import { addTask } from "@/lib/todo/islandBridge";
import type { IslandState, IslandTask } from "@/lib/todo/types";
import { useIslandTaskOps, taskKey } from "./useIslandTaskOps";
import { TodoIslandCompose } from "./TodoIslandCompose";
import styles from "./TodoIsland.module.css";

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
  /** 视图 tab 挂岛层（受控）：岛收起会卸载本组件，tab 挂这里收起一次就被重置（规则 §15.2） */
  tab: "open" | "done";
  onTab: (t: "open" | "done") => void;
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
  tab,
  onTab,
  compose,
  composeText,
  onComposeText,
  onCollapse,
  onComposeOpen,
  onNotice,
}: Props) {
  const { rows, onTick, isDwelling, isPaused, isLeaving, pauseDwell, resumeDwell } =
    useIslandTaskOps(state, tab, onNotice);

  /** 「记一条」：Compose 已把快捷条选择拼成 @ 尾巴，这里只管提交（快捷条设计稿 §3） */
  const onAdd = (text: string) => {
    const body = text.trim();
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
        <span
          className={styles.seg}
          role="tablist"
          aria-label="待办视图"
          onKeyDown={(e) => {
            // roving tabindex（P1-1）：←/→ 在两个 tab 间切换，焦点跟过去。
            // ❗ 焦点目标按位置取，不等 React 重渲染——此刻 aria-selected 还是旧值。
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = tab === "open" ? "done" : "open";
            onTab(next);
            const tabs = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role='tab']");
            (next === "open" ? tabs[0] : tabs[1])?.focus();
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "open"}
            tabIndex={tab === "open" ? 0 : -1}
            className={tab === "open" ? styles.on : undefined}
            onClick={() => onTab("open")}
          >
            进行中
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "done"}
            tabIndex={tab === "done" ? 0 : -1}
            className={tab === "done" ? styles.on : undefined}
            onClick={() => onTab("done")}
          >
            已完成
          </button>
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
            const key = taskKey(t);
            const chip = dueChip(t);
            const dwelling = isDwelling(key) && t.done;
            return (
              <div
                key={key}
                className={`${styles.row} ${t.done ? styles.rowDone : ""} ${dwelling ? styles.rowDwell : ""} ${isPaused(key) ? styles.rowDwellPaused : ""} ${isLeaving(key) ? styles.rowLeave : ""}`}
                role="listitem"
                onClick={() => onTick(t)}
                onMouseEnter={() => pauseDwell(key)}
                onMouseLeave={() => resumeDwell(key)}
              >
                <button
                  className={styles.tick}
                  title={t.done ? "标记为未完成" : "完成"}
                  aria-label={t.done ? "标记为未完成" : "完成"}
                  onClick={(e) => {
                    // 勾圈在行内：不拦冒泡会把同一次点击交给行再 toggle 一遍（翻回去）
                    e.stopPropagation();
                    onTick(t);
                  }}
                >
                  <span className={styles.tickDot}>
                    <TickSvg />
                  </span>
                </button>
                <span className={styles.tx}>{t.text}</span>
                {chip ? <span className={chip.cls}>{chip.text}</span> : null}
                {dwelling ? (
                  <button
                    type="button"
                    className={styles.undoChip}
                    onClick={(e) => {
                      // chip 自己拦冒泡：点撤销不许再触发整行勾选
                      e.stopPropagation();
                      onTick(t);
                    }}
                  >
                    撤销
                  </button>
                ) : null}
                <span
                  className={styles.src}
                  onClick={(e) => {
                    // 来源笔记名不参与整行勾选：这里预留给「打开笔记」
                    e.stopPropagation();
                  }}
                >
                  {t.noteTitle}
                </span>
                {dwelling ? <span className={styles.dwellBar} aria-hidden="true" /> : null}
              </div>
            );
          })
        )}
      </div>

      {compose ? (
        <TodoIslandCompose composeText={composeText} onComposeText={onComposeText} onAdd={onAdd} />
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
