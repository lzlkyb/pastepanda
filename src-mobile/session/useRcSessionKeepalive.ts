/**
 * useRcSessionKeepalive — 会话期间持有 Android 前台服务（B 方案，2026-10-02）。
 *
 * 与 A 方案（useRcBackgroundPause 的 bg_pause 协议）**叠加**而非替代：A 管
 * 「进程活着时别误断」（协议纪律），这个管「进程根本不被冻」（平台底座）——
 * 前台服务把进程升到前台服务态，Cached Apps Freezer 不冻结、LMK 不优先杀，
 * Rust 心跳线程在后台照常跑。想挂多久挂多久，不再受 5 分钟 TTL 约束。
 *
 * 开关锚定会话视图的挂载/卸载（进会话开、退会话停）：
 * - 视图卸载 = 会话从 UI 层面结束（本地点断开 / 对端收口 / 断流），服务必须停，
 *   否则通知栏挂一个「正在远程」的谎；
 * - 服务与 App 同进程：进程被杀服务陪死，不存在跨进程的孤儿状态；
 * - Android 之外（桌面）命令 no-op，hook 照调——会话壳不关心平台差异。
 *
 * 失败静默：保活失败只损失「后台不被冻」这层保险（A 方案还在），
 * 不值得在会话里弹错误。
 */
import { useEffect } from "react";
import { rcKeepaliveSet } from "@/lib/api/rcCommands";

export function useRcSessionKeepalive(sessionId: string | undefined, title: string) {
  useEffect(() => {
    if (!sessionId) return;
    void rcKeepaliveSet(true, title).catch(() => {});
    return () => {
      void rcKeepaliveSet(false, title).catch(() => {});
    };
  }, [sessionId, title]);
}
