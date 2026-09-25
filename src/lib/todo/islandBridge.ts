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

/** 请求 1500ms 后隐藏（全清态收起用；期间被点亮会由 Rust 代次作废）。 */
export function requestDelayedHide(): void {
  invoke("todo_island_hide", { delayMs: 1500 }).catch((e) =>
    logger.warn("[islandBridge] 延迟隐藏失败", e),
  );
}

