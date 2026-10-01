/**
 * useRcHeartbeat — 会话心跳（发起端 → 被控端，每秒一枚 ping）。
 *
 * 被控端两件事都压在这枚 ping 上（`rc/service/streaming.rs`）：
 * - **3.5s 没心跳 → 暂停推流**（省带宽）；
 * - **15s 零入站证据 → 判「对端失联」强制结束会话**（半开链路看门狗）。
 *
 * 桌面端原本在 `useRcLinkState` 里发；手机会话壳没接，2026-10-01 真机联调
 * 就死在这：画面永远等不到（3.5s 即停推），15 秒整场被看门狗掐掉。
 * 抽成共享 hook（规则 11.1）——这条存活性纪律两端必须同一份实现，
 * 第三个会话入口（未来任何端）再漏接一次，表现还是「连上就断」。
 *
 * ❗ 窗口失焦也要发（桌面同款纪律）：否则对端会当断线。
 * ❗ `sessionId` 为空（沙盒 / 未进会话）不跑——空转 ping 没有收件人。
 */
import { useEffect } from "react";
import { rcSendInput } from "@/lib/api/rc";

export const RC_PING_MS = 1000;

export function useRcHeartbeat(sessionId: string) {
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setInterval(() => {
      // ping 载荷的 ts 保持 epoch：它跨进程给对端算 RTT，两端唯一公共基座是墙钟。
      void rcSendInput({ kind: "ping", ts: Date.now() }).catch(() => {
        /* 发送失败由 pong 新鲜度兜底判定，不在这里下结论 */
      });
    }, RC_PING_MS);
    return () => window.clearInterval(t);
  }, [sessionId]);
}
