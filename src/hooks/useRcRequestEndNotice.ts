/**
 * useRcRequestEndNotice — U4：发起的申请被拒/超时后的当下反馈。
 *
 * 现状问题：pending 会话被对方拒绝（reason=拒绝）或 2 分钟超时后，`surface`
 * 直接回设备页，零提示——界面突然「弹回」，用户分不清是拒绝了还是卡了。
 *
 * 实现口径：监听会话相位，`outbound_pending` 消失且**非本机主动取消**时，
 * 重拉历史并按 peer + started_ms 匹配那一条落库记录的 reason 分档 toast
 * （纯函数判据在 `lib/rcHistory.requestEndNotice`，有单测）。
 *
 * 2026-09-23 补第二路（U3）：`outbound_active` 消失（对方结束 / 链路中断）
 * 同样查历史 reason 走 `sessionEndNotice`——旧版只管申请阶段，会话建立后
 * 结束会**静默弹回设备页**，用户分不清是对方动的还是软件坏了。
 *
 * 为什么从历史拿 reason 而不是 `rc_status`：会话结束后 session 为 null，
 * reason 只落库在 `rc_session_history`。`useRcHistory` 平时不自动重拉，
 * 这里在结束的当下补一次 `reload()`，顺带把记录页/侧栏筛选的数据一起刷新。
 */
import { useEffect, useRef, useState } from "react";
import type { ToastFn } from "@/components/Toast";
import type { RcSession, RcTargetDevice } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { requestEndNotice, sessionEndNotice } from "@/lib/rcHistory";
import type { UseRcHistory } from "@/hooks/useRcHistory";

/** 兜底时限：结束时点重拉历史，15 秒内找不到对应记录就收场（写库失败等异常路径）。 */
const NOTICE_TIMEOUT_MS = 15_000;

/** 收场类型：申请没谈成（pending 消失）vs 会话中断/被对方结束（active 消失）。
 *  两者的 reason 词典不同，分别走 requestEndNotice / sessionEndNotice。 */
type EndKind = "request" | "session";

export function useRcRequestEndNotice(
  session: RcSession | null,
  targets: RcTargetDevice[],
  history: UseRcHistory,
  toast: ToastFn,
) {
  /** 渲染期同步当前 pending 会话（同 RcWorkbench 的 deviceUi.syncPeer 手法）：
      相位消失时 session 已是 null，只有 ref 里还留着 peer 与 started_ms。 */
  const pendingRef = useRef<{ peer: string; startedMs: number } | null>(null);
  if (session?.phase === "outbound_pending") {
    pendingRef.current = { peer: session.peer, startedMs: session.started_ms };
  }

  /** 同上手法：监听「曾经 active」的会话消失（对端结束 / 链路异常收口）。 */
  const wasActiveRef = useRef<{ peer: string; startedMs: number } | null>(null);
  if (session?.phase === "outbound_active") {
    wasActiveRef.current = { peer: session.peer, startedMs: session.started_ms };
  }

  const [endCheck, setEndCheck] = useState<{
    peer: string;
    startedMs: number;
    kind: EndKind;
  } | null>(null);

  const prevPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const cur = session?.phase ?? null;
    prevPhaseRef.current = cur;
    const wasEngaged = prev === "outbound_pending" || prev === "outbound_active";
    const nowIdle = cur !== "outbound_pending" && cur !== "outbound_active";
    if (wasEngaged && nowIdle) {
      // active 消失优先按「会话收场」报（它带着 pending→active→null 的全程）；
      // 只有从没活过的申请才走「申请收场」词典。
      const base = wasActiveRef.current ?? pendingRef.current;
      const kind: EndKind = wasActiveRef.current ? "session" : "request";
      if (base) {
        setEndCheck({ ...base, kind });
        void history.reload();
      }
      pendingRef.current = null;
      wasActiveRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!endCheck) return;
    const timer = window.setTimeout(() => setEndCheck(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [endCheck]);

  useEffect(() => {
    if (!endCheck) return;
    // started_ms 带 2 秒容差：落库时间与状态里的值理论同源，但不赌它逐毫秒相等；
    // 取最新一条（多设备并发发起同一 peer 的场景几乎不存在，取 max 足够稳）。
    const hit = history.list
      .filter(
        (h) =>
          h.peer === endCheck.peer &&
          h.dir === "outbound" &&
          h.started_ms >= endCheck.startedMs - 2_000,
      )
      .sort((a, b) => b.started_ms - a.started_ms)[0];
    if (!hit) return;
    setEndCheck(null);
    const notice =
      endCheck.kind === "session" ? sessionEndNotice(hit.reason) : requestEndNotice(hit.reason);
    if (!notice) return;
    const t = targets.find((x) => x.node_id === endCheck.peer);
    const name = t ? rcDisplayName(t, fingerprintOf(endCheck.peer)) : fingerprintOf(endCheck.peer);
    toast(`「${name}」${notice.text}`, notice.tone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endCheck, history.list]);
}
