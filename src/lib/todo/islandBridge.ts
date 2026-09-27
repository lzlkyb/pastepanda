/**
 * 岛窗口的**唯一**同步出口（实施方案 §5 #6）。
 *
 * 岛是独立 webview：主窗口的 zustand store、任何主窗口内状态它都拿不到；
 * 数据只能来自 Rust。推送方向是**单向**的：
 *
 * ```text
 * Rust（refresh_island，所有笔记写路径收口）──► 「todo-island-update」推送 ──► 本桥
 *                                          └──► IslandStateCache 快照 ──► 本桥 mount 拉取
 * ```
 *
 * 前端（包括岛自己）**没有**任何往岛推状态的通道 ——「两处各推一次 → 显示 A 实际 B」
 * 的漂移从结构上不可能发生。岛内组件一律经 `useIslandState()` 取数，禁止自行
 * 再 listen / invoke 一份（那是第二出口，漂移就是那么来的）。
 *
 * 三个取数时机，各管一种丢法：
 * 1. **mount 拉快照** —— 窗口首次创建时 Rust 的 emit 赶不上 webview 就绪，事件会静默丢
 *    （栈浮标踩过的首帧空白坑）；`todo_island_tasks` 现算一遍，顺带把缓存焐热；
 * 2. **订阅推送** —— 笔记写路径（编辑保存 / 速记 / MCP / 恢复 / 导入）实时到达；
 * 3. **`todo-island-shown` 重拉** —— 同步引擎直写路径没有钩子（拿不到 AppHandle），
 *    它必然带新 `updated_ms`，重拉一次扫描就能看到，岛每次显示都自愈。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import type { IslandState, IslandTask } from "@/lib/todo/types";

const EMPTY: IslandState = { total: 0, done: 0, hint: "", tasks: [], doneTasks: [] };

/**
 * 岛状态的唯一取数口。返回当前状态；组件只管渲染，写回走下面的动作函数。
 */
export function useIslandState(): IslandState {
  const [state, setState] = useState<IslandState>(EMPTY);

  useEffect(() => {
    let alive = true;
    // 失败**不清空已有状态**（U3.5：catch 不许落空态）——旧数据比白屏诚实
    const pull = () =>
      invoke<IslandState>("todo_island_tasks")
        .then((s) => {
          if (alive) setState(s);
        })
        .catch((e) => logger.warn("[islandBridge] 拉取待办失败", e));

    pull();
    const offUpdate = listen<IslandState>("todo-island-update", (e) => {
      if (alive) setState(e.payload);
    });
    const offShown = listen("todo-island-shown", () => pull());
    return () => {
      alive = false;
      void offUpdate.then((f) => f());
      void offShown.then((f) => f());
    };
  }, []);

  return state;
}

/**
 * 勾选 / 取消一条待办（B3）。
 *
 * 成功时 Rust 会顺手重扫并广播新状态，调用方**不需要**再手动刷新；
 * 失败（行号漂移 / 笔记没了 / 库异常）返回错误文案，调用方负责把 UI 回滚并让用户看见。
 */
export async function toggleTask(task: IslandTask): Promise<void> {
  await invoke("todo_island_toggle_task", {
    noteId: task.noteId,
    line: task.line,
    expectedText: task.text,
  });
}

/**
 * 「记一条」（B4）：往**今天的速记**的 `- [ ]` 清单区追加一行。
 * 成功后同样由 Rust 广播新状态。
 */
export async function addTask(text: string): Promise<void> {
  await invoke("note_append_daily_task", { text });
}

/**
 * 通知 Rust 切舞台（收起/悬停/展开/输入/全清的窗口尺寸一次到位）。
 * 几何口径见 `todo_island_stage.rs`；失败只记日志——窗口几何错了不该拖垮交互。
 */
export function setStage(stage: string): void {
  invoke("todo_island_set_stage", { stage }).catch((e) =>
    logger.warn("[islandBridge] 切舞台失败", e),
  );
}

/** 请求点亮岛（也用于作废挂起的延迟隐藏：Rust 侧 show 会递增代次）。 */
export function requestShow(): void {
  invoke("todo_island_show").catch((e) => logger.warn("[islandBridge] 点亮岛失败", e));
}

/** 热键召唤路径补焦点（critique P1-1）：岛窗平时刻意不抢焦点（todo_island.rs），
 *  只有用户按热键显式召唤直进输入态时才把焦点给岛——落地即可打字。 */
export function requestIslandFocus(): void {
  invoke("todo_island_focus").catch((e) => logger.warn("[islandBridge] 岛窗聚焦失败", e));
}

/** 请求 2500ms 后隐藏（全清态收起用；期间被点亮会由 Rust 代次作废）。
 *  2500 = critique 2026-09-27 P3：全清是待办工具的情绪峰值，1500ms 用户还没看清就没了。 */
export function requestDelayedHide(): void {
  invoke("todo_island_hide", { delayMs: 2500 }).catch((e) =>
    logger.warn("[islandBridge] 延迟隐藏失败", e),
  );
}

/** 「记一条」@时间 预览结果（Rust `todo_island_parse_due` 的载荷，同一份解析链）。
 *  ok=false = 有尾巴但没看懂（⚠ 态）；null 载荷 = 没有 @ 尾巴。 */
export interface DuePreview {
  ok: boolean;
  label: string;
  hasTime: boolean;
}

/** @时间 预览：本地解析命令（微秒级），解析真值**永远**以 Rust 为准——
 *  前端的 hasAtTail 只管「要不要显示预览条」，绝不做第二份语法判断。 */
export function parseDuePreview(text: string): Promise<DuePreview | null> {
  return invoke<DuePreview | null>("todo_island_parse_due", { text });
}

/** 输入尾部是否挂着 @尾巴形状（与 Rust due_tail 的形状规则同口径：空白后 @、
 *  行尾 1–2 词、剥尾后文字非空）。仅用于预览条显隐 / 是否 invoke。 */
export function hasAtTail(text: string): boolean {
  const t = text.trimEnd();
  const at = t.lastIndexOf("@");
  if (at <= 0 || !/\s/.test(t[at - 1])) return false;
  const words = t.slice(at + 1).trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 2 && t.slice(0, at).trimEnd().length > 0;
}

/** 摘掉文本末尾的 @ 尾巴（⚠ 态「删 @尾巴」按钮 / 快捷条带选择提交前共用同一份）。
 *  形状守卫与 Rust due_tail 同口径：@ 前须有空白——邮箱里的 @ 不是尾巴，不许误摘。 */
export function stripAtTail(text: string): string {
  const t = text.trimEnd();
  const at = t.lastIndexOf("@");
  if (at <= 0 || !/\s/.test(t[at - 1])) return text;
  return t.slice(0, at).trimEnd();
}

/** 打 @ 的**任意进行中形态**（含裸 @）——快捷条选择的清除触发（快捷条设计稿 §3 ③）。
 *  与 hasAtTail 的区别：它在 @ 后还没词时也为真——用户一打 @ 就得清快捷条，
 *  不能等尾巴成形；与 Rust due_tail 同口径：@ 前须有空白。 */
export function atTailStarted(text: string): boolean {
  return /\s@/.test(text);
}

/** ===== 记一条 · 常驻时间快捷条（快捷条设计稿 §3.5）=====
 *  时间来源收口：快捷条选中项在**提交时**拼回 `@日期 [时刻]` 尾巴，走的仍是
 *  Rust `due_tail` 同一条解析链——前端不做第二份时间计算（规则 11.1）。 */

/** 三个相对日是快捷条的固定日期档；跨出它的需求是 @ 语法的领地（精确档） */
export const QUICK_DATES = ["今天", "明天", "后天"] as const;

/** 时刻 chip 的默认三项（自适应回落值） */
export const DEFAULT_QUICK_TIMES = ["9:00", "14:00", "18:00"] as const;

const QUICK_TIMES_KEY = "pp.island.quickTimes";

/** top3 纯函数（守卫单测钉住）：按使用次数取前 3，不足 3 个用默认项补齐——
 *  默认项永远在候选里，新用户看到的就是 9:00 / 14:00 / 18:00。 */
export function topQuickTimes(counts: Record<string, number>): string[] {
  const ranked = Object.entries(counts)
    .filter(([, c]) => typeof c === "number" && c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  for (const d of DEFAULT_QUICK_TIMES) {
    if (ranked.length >= 3) break;
    if (!ranked.includes(d)) ranked.push(d);
  }
  return ranked.slice(0, 3);
}

/** 本 compose 会话的时刻档：读一次、会话内不换目标（设计稿 §3.5 ③ 防点击漂移）。 */
export function loadQuickTimes(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_TIMES_KEY);
    if (!raw) return [...DEFAULT_QUICK_TIMES];
    const counts = JSON.parse(raw) as unknown;
    return topQuickTimes(counts && typeof counts === "object" ? (counts as Record<string, number>) : {});
  } catch {
    return [...DEFAULT_QUICK_TIMES];
  }
}

/** 创建带时刻的待办时计一次数（纯本地，无网络）；存储不可用就静默退回固定三项。 */
export function recordQuickTime(t: string): void {
  try {
    const counts = JSON.parse(localStorage.getItem(QUICK_TIMES_KEY) ?? "{}") as Record<string, number>;
    counts[t] = (typeof counts[t] === "number" ? counts[t] : 0) + 1;
    localStorage.setItem(QUICK_TIMES_KEY, JSON.stringify(counts));
  } catch {
    /* 不挡记事 */
  }
}

