/**
 * useRcTransferNotice — U2：文件传输进度离开文件页仍可见。
 *
 * 现状问题：`RcFilePanel` 只在文件页渲染；切到设备页/记录页后，传输完成、
 * 失败、进度全部不可见（`RcFileOverlay` 只管「请求确认」，不管已有任务）。
 *
 * 三层反馈（全部来自既有 `rcFileStore` 快照，不新增后端）：
 * ① 侧栏顶部摘要条（进行中：设备 + 官方 barSummary 文案，点击回文件页）；
 * ② 「文件」导航角标 = 进行中任务数；
 * ③ 终态 toast —— 用户**不在文件页**时才报（在文件页看着呢，面板本身就是反馈）。
 */
import { useEffect, useMemo, useRef } from "react";
import type { ToastFn } from "@/components/Toast";
import type { RcFileTaskState } from "@/lib/api/rcFile";
import type { RcTargetDevice } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { isTerminal, runningTasks, transferStripLabel } from "@/lib/rcFile";
import { useRcFile } from "@/hooks/useRcFile";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";

export interface RcTransferStrip {
  /** 一句话（按任务真实方向）：`传给 客厅的电脑 · 传文件中 1/3 · 42% · 6.2 MB/s`
   *  或 `客厅的电脑 传来 · …`。 */
  label: string;
  onClick: () => void;
}

export function useRcTransferNotice(
  page: RcA2Page,
  targets: RcTargetDevice[],
  onOpenFiles: () => void,
  toast: ToastFn,
) {
  const files = useRcFile(null);
  /** 上一帧各任务的状态——只对「状态发生跃迁」的任务报，重挂/首次不报旧账。 */
  const seenRef = useRef<Map<string, RcFileTaskState>>(new Map());

  useEffect(() => {
    const prev = seenRef.current;
    const next = new Map<string, RcFileTaskState>();
    for (const t of files.tasks) {
      next.set(t.id, t.state);
      const before = prev.get(t.id);
      if (!before || before === t.state || !isTerminal(t.state) || page === "files") continue;
      const label =
        t.state === "done"
          ? "传输完成"
          : t.state === "canceled"
            ? "已取消"
            : `传输失败${t.err ? `：${t.err}` : ""}`;
      toast(
        `「${t.name}」${label}`,
        t.state === "done" ? "success" : t.state === "canceled" ? "info" : "error",
      );
    }
    seenRef.current = next;
  }, [files.tasks, page, toast]);

  const running = files.running;

  const strip: RcTransferStrip | null = useMemo(() => {
    if (page === "files") return null;
    const cur = runningTasks(files.tasks)[0];
    if (!cur) return null;
    const t = targets.find((x) => x.node_id === cur.peer);
    const name = t ? rcDisplayName(t, fingerprintOf(cur.peer)) : cur.peer_name || fingerprintOf(cur.peer);
    return {
      // 方向必须跟着任务的真实 dir 走（审计修：曾写死「传给」，收方向任务时撒谎）
      label: `${transferStripLabel(cur.dir, name)}${files.summary ? ` · ${files.summary}` : ""}`,
      onClick: onOpenFiles,
    };
    // summary 随 tasks 变化，files.tasks 与 files.summary 都在依赖里，随轮询自然刷新
  }, [page, files.tasks, files.summary, targets, onOpenFiles]);

  return { running, strip };
}
