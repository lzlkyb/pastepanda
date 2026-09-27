/**
 * 岛列表的写回状态机（2026-09-27 从 TodoIslandList 拆出：规则 #7 文件红线；
 * 视图归 TodoIslandList，这里只管「点勾之后发生什么」）。
 *
 * ## 乐观翻面与写回（B3 原有机制，不动）
 * 点勾 → 本地翻面（乐观）+ `toggleTask` 写库（noteId+line+原文一起带去防漂移）；
 * 服务器广播与翻面一致时丢标记；失败时 Rust 推送库里的真实现状（自愈），
 * 这里回滚乐观标记并由调用方把「没勾上」说出口。
 *
 * ## 完成态驻留（critique P1-2 新增，设计稿《勾选撤销驻留与键盘路径》）
 * 勾选后行**留在原位** 6s：完成态样式 + 行尾「撤销」chip + 底部倒计时条。
 * 写回在点击瞬间已发生，驻留只是给反悔留的窗口：
 * - **悬停该行 → 倒计时暂停**（CSS 条停住 + JS 计时挂起），移开恢复；
 * - 点 chip / 再点勾圈 → 再发一次 toggle 回未完成，驻留计时取消；
 * - 6s 到 → 行进退场动画（EXIT_MS，.rowLeave）放完才摘渲染；
 * - 服务器把任务归档后它会从 state.tasks 消失 → 由**快照**（含勾选时的
 *   插入位置）续命渲染到驻留结束，行不会在推送到达瞬间跳没。
 *
 * 🔴 三套瞬态（翻面 / 驻留 / 退场）都以服务器现状收敛：任务活着回到列表
 *    且是未完成（撤销已确认 / 被外部改回）时全部作废——旧标记不许压住活行。
 */
import { useEffect, useRef, useState } from "react";
import { toggleTask } from "@/lib/todo/islandBridge";
import type { IslandState, IslandTask } from "@/lib/todo/types";

/** 乐观翻面标记的键：一篇笔记同一行只会有一条任务 */
export const taskKey = (t: IslandTask) => `${t.noteId}:${t.line}`;

/** 完成态驻留时长（critique P1-2 定稿）：与展开态闲置自收同数量级，够看完 + 想反悔 */
const DWELL_MS = 6000;
/** 驻留结束后的退场动画时长：与 CSS `.rowLeave` 的 200ms 过渡配一套——改这里必须同步那边 */
const EXIT_MS = 200;

/** 驻留快照：勾选那一刻翻好面的任务 + 它在列表里的插入位置（保住「留在原位」） */
interface DwellEntry {
  task: IslandTask;
  idx: number;
}

export function useIslandTaskOps(
  state: IslandState,
  tab: "open" | "done",
  onNotice: (msg: string | null) => void,
) {
  const [flips, setFlips] = useState<Map<string, boolean>>(new Map());
  // 驻留快照：key → 翻好面的任务 + 插入位。服务器归档后靠它续命渲染。
  const [dwell, setDwell] = useState<Map<string, DwellEntry>>(new Map());
  // 退场中的行：还渲染（.rowLeave 动画可见），动画放完才随快照一起摘除
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  // 悬停暂停中的行：只驱动 CSS（条停住提亮），计时挂起在 ref 里
  const [dwellPaused, setDwellPaused] = useState<Set<string>>(() => new Set());
  const dwellTimers = useRef<Map<string, number>>(new Map());
  /** 正常计时存截止时刻；暂停时改存剩余 ms（恢复时用） */
  const dwellDeadline = useRef<Map<string, number>>(new Map());
  const exitTimers = useRef<Map<string, number>>(new Map());

  const applyFlip = (t: IslandTask): IslandTask => {
    const v = flips.get(taskKey(t));
    return v === undefined ? t : { ...t, done: v };
  };

  const stopDwellTimer = (key: string) => {
    const timer = dwellTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dwellTimers.current.delete(key);
    }
    dwellDeadline.current.delete(key);
    setDwellPaused((prev) => {
      if (!prev.has(key)) return prev;
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
  };

  const cancelExit = (key: string) => {
    const timer = exitTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      exitTimers.current.delete(key);
    }
    setLeaving((prev) => {
      if (!prev.has(key)) return prev;
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
  };

  /** 驻留到点：行进退场动画，动画放完才把快照摘掉（DOM 随之消失） */
  const finishDwell = (key: string) => {
    stopDwellTimer(key);
    setLeaving((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    const exit = window.setTimeout(() => {
      exitTimers.current.delete(key);
      cancelExit(key);
      setDwell((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Map(prev);
        n.delete(key);
        return n;
      });
    }, EXIT_MS);
    exitTimers.current.set(key, exit);
  };

  const enterDwell = (snap: IslandTask, idx: number) => {
    const key = taskKey(snap);
    stopDwellTimer(key);
    setDwell((prev) => new Map(prev).set(key, { task: snap, idx }));
    dwellDeadline.current.set(key, Date.now() + DWELL_MS);
    dwellTimers.current.set(
      key,
      window.setTimeout(() => finishDwell(key), DWELL_MS),
    );
  };

  // 悬停暂停 / 移开恢复（设计稿 S2：悬停该行 = 倒计时暂停）。
  // 语义判定都走 ref：没在计时（= 没在驻留或已暂停）就是 no-op。
  const pauseDwell = (key: string) => {
    const timer = dwellTimers.current.get(key);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    dwellTimers.current.delete(key);
    dwellDeadline.current.set(
      key,
      Math.max(0, (dwellDeadline.current.get(key) ?? 0) - Date.now()),
    );
    setDwellPaused((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };

  const resumeDwell = (key: string) => {
    if (dwellTimers.current.has(key)) return;
    const left = dwellDeadline.current.get(key);
    if (left === undefined) return;
    dwellDeadline.current.set(key, Date.now() + left);
    dwellTimers.current.set(
      key,
      window.setTimeout(() => finishDwell(key), left),
    );
    setDwellPaused((prev) => {
      if (!prev.has(key)) return prev;
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
  };

  const onTick = (t: IslandTask) => {
    const key = taskKey(t);
    const target = !t.done;
    setFlips((prev) => new Map(prev).set(key, target));
    if (!target) {
      // 撤销完成：计时全停。快照**保留**到服务器确认（推送到达由收敛逻辑摘除），
      // 不然推送到达前这一拍行会闪一下没。
      stopDwellTimer(key);
      cancelExit(key);
    } else {
      const idx = rows.findIndex((r) => taskKey(r) === key);
      enterDwell({ ...t, done: true }, idx < 0 ? rows.length : idx);
    }
    toggleTask(t).catch(() => {
      // 失败：翻面作废 + 驻留/退场全取消，行回到列表原位的未完成态
      stopDwellTimer(key);
      cancelExit(key);
      setFlips((prev) => {
        const n = new Map(prev);
        n.delete(key);
        return n;
      });
      // Rust 失败路径会推送库里的真实现状（自愈）；这里只负责把「没勾上」说出口
      onNotice("这条待办刚被其它途径改过，已还原");
    });
  };

  // 渲染行：「进行中」= 活跃任务 + 仍在驻留期的快照（按勾选时的位置插回）；
  // 「已完成」= 已归档任务。翻面统一套用。
  const liveOpen = state.tasks.map(applyFlip);
  let rows: IslandTask[];
  if (tab === "open") {
    const liveKeys = new Set(state.tasks.map(taskKey));
    rows = [...liveOpen];
    for (const [k, { task, idx }] of dwell) {
      if (liveKeys.has(k)) continue;
      rows.splice(Math.min(Math.max(idx, 0), rows.length), 0, applyFlip(task));
    }
  } else {
    rows = state.doneTasks.map(applyFlip);
  }

  // 服务器现状已体现翻面（或那条任务消失了）→ 乐观标记完成使命，丢掉
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

  // 瞬态收敛：三套标记都以服务器现状为准。
  // - 任务活着回到「进行中」且未完成、翻面已清（撤销确认 / 被外部改回）→ 驻留快照与退场标记全收；
  // - 任务彻底消失（笔记 / 行被删）→ 快照收；
  // - 翻面还挂着（乐观待推送）时不动——收早了行会闪。
  useEffect(() => {
    const all = [...state.tasks, ...state.doneTasks];
    const liveOpenKeys = new Set(state.tasks.map(taskKey));
    const aliveUndone = (k: string) => {
      if (!liveOpenKeys.has(k) || flips.has(k)) return false;
      const t = state.tasks.find((x) => taskKey(x) === k);
      return !!t && !t.done;
    };
    setDwell((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      let changed = false;
      for (const k of [...next.keys()]) {
        const gone = !all.some((x) => taskKey(x) === k);
        if (aliveUndone(k) || gone) {
          stopDwellTimer(k);
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setLeaving((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((k) => !aliveUndone(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [state, flips]);

  // 岛收起时本组件会被卸载，没跑的计时器不能留着
  useEffect(
    () => () => {
      dwellTimers.current.forEach((id) => window.clearTimeout(id));
      dwellTimers.current.clear();
      exitTimers.current.forEach((id) => window.clearTimeout(id));
      exitTimers.current.clear();
    },
    [],
  );

  return {
    rows,
    onTick,
    isDwelling: (key: string) => dwell.has(key),
    isPaused: (key: string) => dwellPaused.has(key),
    isLeaving: (key: string) => leaving.has(key),
    pauseDwell,
    resumeDwell,
  };
}
