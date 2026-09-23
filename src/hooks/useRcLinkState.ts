/**
 * useRcLinkState — 会话「链接状态」收口（2026-09-17 从 `RcSessionView` 抽出）。
 *
 * # 为什么要有这个 hook
 *
 * 原来心跳、停滞、RTT 三件事内联在 `RcSessionView` 的三个 `useEffect` 里，
 * 而那个文件是 299/300 行（红线）。更糟的是判据本身错了：
 *
 * - 心跳用 `rcSendInput(ping).then(→正常)` —— invoke resolve 只证明 ping 进了
 *   **本地**发送队列，不证明对端回了 pong。
 * - 停滞用「2.5s 没新帧」，而被控端在画面无变化时刻意不推帧
 *   （`rc/video.rs` `DirtyOutcome::Static`）。两者语义冲突 ⇒ 必然误报。
 *
 * # 现在的判据分工（三者互不代言）
 *
 * | 问题 | 数据源 | 阈值 |
 * |---|---|---|
 * | 链路还活着吗 | 对端 pong 的新鲜度 | `HEARTBEAT_STALE_MS` / `HEARTBEAT_FAIL_MS` |
 * | 画面多久没变了 | 帧到达时间（中性观测） | `FRAME_IDLE_MS` |
 * | 我操作了怎么没反应 | 操作时间 vs 帧到达时间 | `ACTION_UNANSWERED_MS` |
 *
 * # pong 时间戳的两个来源（C3 后一律单调域）
 *
 * 优先用后端的 `pong_age_ms`（严格：`note_pong` 只在真的收到 pong 时调用）。
 * 🔴 C3（2026-09-23 审计）：后端不再下发裸时刻而是 **age**（距 pong 多少毫秒）
 * ——后端的时间基座是进程私有单调钟，墙钟一跳（NTP/改表/睡眠唤醒）会把
 * 「距最后一次 pong」算成任意值。前端收到 age 的瞬间用 `performance.now()`
 * 定锚，之后外推；本 hook 内所有时间（会话起点、帧到达、操作时刻、本地 pong）
 * 全在 performance.now 单调域，不碰 `Date.now()`（ping 载荷的 ts 例外——
 * 那是给**对端进程**算 RTT 的，跨进程只能约定公共基座，保持 epoch）。
 * 后端字段还没就绪时退化为「前端观察 `rtt_ms` 变化」——**这个近似不严谨**
 * （RTT 恰好每轮相同会误判为无变化），所以后端字段一旦可用就该走它。
 */
import { useEffect, useRef, useState } from "react";
import { rcSendInput } from "@/lib/api/rc";
import {
  actionUnansweredMs,
  frameIdleMs as computeFrameIdleMs,
  linkStateOf,
  type RcLinkState,
} from "@/lib/rcSessionStats";

/** ping 发送周期。被控端 3.5s 收不到心跳会暂停推流，所以不能停。 */
const PING_MS = 1000;
/** 派生状态的刷新周期。派生值已量化到秒，实际每秒最多一次 setState。 */
const TICK_MS = 500;

export interface RcLinkSnapshot {
  /** 后端实测 RTT（ms），0 = 尚未测到。 */
  rttMs: number;
  /** 链路状态（见 `RcLinkState`）。 */
  state: RcLinkState;
  /** 画面静止秒数，0 = 不显示（中性观测，不是故障）。 */
  frameIdleSec: number;
  /** 操作后未响应秒数，0 = 不提示。 */
  unansweredSec: number;
}

const INITIAL: RcLinkSnapshot = {
  rttMs: 0,
  state: "connecting",
  frameIdleSec: 0,
  unansweredSec: 0,
};

export function useRcLinkState({
  sessionId,
  hasFrame,
  lastFrameAt,
  lastActionAt,
  rttMs,
  backendPongAgeMs,
  reconnecting = false,
}: {
  sessionId: string;
  hasFrame: boolean;
  /** performance.now 域的帧到达时刻（见 `useRcFrames`，C3 起非 Date.now）。 */
  lastFrameAt: React.MutableRefObject<number>;
  /** performance.now 域的最后一次操作时刻（见 `useRcInput`）。 */
  lastActionAt: React.MutableRefObject<number>;
  rttMs: number;
  /** 后端 `RcStatus.pong_age_ms`；null/undefined = 本会话还没收到过 pong。 */
  backendPongAgeMs?: number | null;
  reconnecting?: boolean;
}): RcLinkSnapshot {
  /** 本地近似的「最后一次 pong」（performance.now 域）：观察 `rtt_ms` 变化推断。 */
  const localPongAt = useRef(0);
  const lastRttSeen = useRef(0);
  // 🔴 C3：后端 age 定锚成 performance.now 域的时刻——age 到达即定锚，
  // 之后外推 `perfAt - age` 恒为「最后一次 pong 在本地单调域的时刻」。
  // 定锚晚了几毫秒只会把 pong 显得更旧，方向保守。
  const pongAnchor = useRef<{ perfAt: number; age: number } | null>(null);
  const sessionStartRef = useRef(0);
  const [snap, setSnap] = useState<RcLinkSnapshot>(INITIAL);

  // age 更新 ⇒ 重新定锚；null（新会话一条 pong 都没有）⇒ 清锚，
  // 防止上一场会话的 pong 给这一场的加载态续命。
  useEffect(() => {
    if (backendPongAgeMs == null) {
      pongAnchor.current = null;
    } else {
      pongAnchor.current = { perfAt: performance.now(), age: Math.max(0, backendPongAgeMs) };
    }
  }, [backendPongAgeMs]);

  // 心跳发送：会话内不停（窗口失焦也发，否则对端会当断线）。
  // 注意这里**不**用 resolve/reject 判活性——那只是本地 IPC 的结果。
  useEffect(() => {
    localPongAt.current = 0;
    lastRttSeen.current = 0;
    pongAnchor.current = null;
    // 「从未见过 pong」的起点：超过 HEARTBEAT_FAIL_MS 还没收到第一个 pong
    // 就判 failed，加载态不许永远演「连接中」（U3）。单调域，会话中途改系统时间不影响。
    sessionStartRef.current = performance.now();
    setSnap(INITIAL);
    const t = window.setInterval(() => {
      // ping 载荷的 ts 保持 epoch：它跨进程给对端算 RTT，两端唯一公共基座是墙钟。
      void rcSendInput({ kind: "ping", ts: Date.now() }).catch(() => {
        /* 发送失败由 pong 新鲜度兜底判定，不在这里下结论 */
      });
    }, PING_MS);
    return () => window.clearInterval(t);
  }, [sessionId]);

  // 后端 RTT 变化 ⇒ 收到过 pong（退化判据）
  useEffect(() => {
    if (rttMs > 0 && rttMs !== lastRttSeen.current) {
      lastRttSeen.current = rttMs;
      localPongAt.current = performance.now();
    }
  }, [rttMs]);

  useEffect(() => {
    const t = window.setInterval(() => {
      const now = performance.now();
      const anchored = pongAnchor.current;
      const pong = anchored ? anchored.perfAt - anchored.age : localPongAt.current;
      const next: RcLinkSnapshot = {
        rttMs,
        state: linkStateOf(pong, now, reconnecting, sessionStartRef.current),
        frameIdleSec: Math.floor(computeFrameIdleMs(lastFrameAt.current, now, hasFrame) / 1000),
        unansweredSec: Math.floor(
          actionUnansweredMs(lastFrameAt.current, lastActionAt.current, now) / 1000,
        ),
      };
      setSnap((p) =>
        p.rttMs === next.rttMs &&
        p.state === next.state &&
        p.frameIdleSec === next.frameIdleSec &&
        p.unansweredSec === next.unansweredSec
          ? p
          : next,
      );
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, [hasFrame, lastFrameAt, lastActionAt, rttMs, backendPongAgeMs, reconnecting]);

  return snap;
}
