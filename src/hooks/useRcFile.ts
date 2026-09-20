/**
 * useRcFile — 文件传输状态的薄壳（G6，B4），本组件视图。
 *
 * 与 `useRc` 同一手法：真正的状态与事件监听全在 `rcFileStore`（单例），
 * 本 hook 只做三件事——订阅、挂载时 acquire / 卸载时 release、按 `peer` 过滤。
 *
 * `peer` 传 null / 省略 = 不过滤（主窗常驻横幅、设备卡片独立面板用它看全部）。
 * 会话内的场景传对端 node_id，避免把别的设备的任务串进当前会话的底栏。
 */
import { useEffect, useMemo } from "react";
import { useRcFileStore } from "@/stores/rcFileStore";
import { barSummary, runningTasks, sortTasks } from "@/lib/rcFile";
import type { RcFileAsk, RcFileTask } from "@/lib/api/rcFile";

export interface RcFileView {
  /** 当前 peer 待用户响应的请求（确认条）。 */
  asks: RcFileAsk[];
  /** 已排序的任务列表（运行中在上）。 */
  tasks: RcFileTask[];
  /** 运行中的任务数。 */
  running: number;
  /** 取某条任务的速率（字节/秒）；0 = 还没量到。 */
  rateOf: (t: RcFileTask) => number;
  /** 底栏那一句汇总；null = 无运行中任务（不占位）。 */
  summary: string | null;
  busy: boolean;
  error: string | null;

  send: (paths: string[]) => Promise<boolean>;
  pull: (dir: string) => Promise<boolean>;
  respond: (askId: string, acceptDir: string | null) => Promise<boolean>;
  cancel: (taskId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRcFile(peer?: string | null): RcFileView {
  const snapshot = useRcFileStore((s) => s.snapshot);
  const rates = useRcFileStore((s) => s.rates);
  const busy = useRcFileStore((s) => s.busy);
  const error = useRcFileStore((s) => s.error);

  // 挂载=订阅（首个订阅者装事件监听 + 取首帧），卸载=退订
  useEffect(() => {
    const st = useRcFileStore.getState();
    st.acquire();
    return () => useRcFileStore.getState().release();
  }, []);

  const asks = useMemo(
    () => (peer ? snapshot.asks.filter((a) => a.peer === peer) : snapshot.asks),
    [snapshot.asks, peer],
  );
  const tasks = useMemo(() => {
    const list = peer ? snapshot.tasks.filter((t) => t.peer === peer) : snapshot.tasks;
    return sortTasks(list);
  }, [snapshot.tasks, peer]);

  const rateOf = useMemo(() => (t: RcFileTask) => rates[t.id] ?? 0, [rates]);
  const summary = useMemo(() => barSummary(tasks, rateOf), [tasks, rateOf]);
  const running = useMemo(() => runningTasks(tasks).length, [tasks]);

  // actions 在 store 里是稳定引用，渲染期取一次即可（同 useRc）
  const a = useRcFileStore.getState();
  return {
    asks,
    tasks,
    running,
    rateOf,
    summary,
    busy,
    error,
    // 这两个把当前 peer 绑进去，调用点不用重复传（peer 为空 = 让后端按不合法参数拒掉，
    // 比静默发一条无 peer 的请求诚实）
    send: (paths: string[]) => a.send(peer ?? "", paths),
    pull: (dir: string) => a.pull(peer ?? "", dir),
    respond: a.respond,
    cancel: a.cancel,
    clearFinished: a.clearFinished,
    refresh: a.refresh,
  };
}
