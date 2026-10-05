/**
 * useRcBackgroundPause — 发起端页面进/出后台 → 通知被控端（B 方案后台保活，2026-10-02）。
 *
 * 为什么必须有这条：手机切后台后 WebView 随 Activity 暂停、进程稍后被系统
 * 冻结——JS 一切定时器停摆。若什么都不做，被控端 15s 心跳看门狗就会把会话
 * 收口（「切后台再回来远程就断了」的根因）。这一 hook 抢在**冻结前**（
 * visibilitychange 触发时 JS 还活着）把 `bg_pause` 发出去，被控端随即挂起
 * 推流并把看门狗放宽到 5 分钟（`link::PEER_BG_TTL_MS`）；回前台发
 * `bg_resume`，被控端立即补关键帧，画面秒回。
 *
 * 心跳本身**不在这里发**：心跳已下沉到发起端 Rust（`outbound.rs` 的
 * `HEARTBEAT_PING_MS` 任务）——WebView 暂停/冻结不影响 Rust 线程，前台场景
 * 不会再因为「UI 停摆」误断；后台场景由 BgPause 的 TTL 兜底。
 *
 * 桌面端同样接（规则 11.1 两壳同一份实现）：窗口最小化时被控端同步停推，
 * 省对方的 CPU/带宽。
 *
 * `sessionId` 为空（沙盒 / 未进会话）不订阅——没有会话就没有收件人。
 */
import { useEffect } from "react";
import { rcSendInput } from "@/lib/api/rc";

export function useRcBackgroundPause(sessionId: string) {
  useEffect(() => {
    if (!sessionId) return;
    const onVisibility = () => {
      // 发送失败（会话刚好收口）不打扰用户：生命周期通知，不是用户动作
      const kind = document.visibilityState === "hidden" ? "bg_pause" : "bg_resume";
      void rcSendInput({ kind }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sessionId]);
}
