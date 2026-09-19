/**
 * rcWorkbench — 工作台「主区该显示什么」的唯一判据（纯函数，可单测）。
 *
 * 为什么单独立一个文件而不是写在组件里：上一版的判据是内联的
 * `session?.phase === "outbound_active"`，它把 **inbound 会话整个漏掉了**——
 * 用户正被别人控着，工作台主区却在问「要不要在左侧选一台设备发起远程」。
 * 这种「漏一个分支」的错，只有把判据抽成可枚举的纯函数 + 补一条单测才拦得住。
 */
import type { RcSession, RcStatus } from "@/lib/api/rc";

/**
 * - `inbound`：本机**被控**（别人在看/控你）——主区要显示被控视图；
 * - `outbound`：本机在控别人——主区显示画面；
 * - `pending`：已发出申请、等对方点头；
 * - `idle`：没有会话。
 */
export type WbMainMode = "inbound" | "outbound" | "pending" | "idle";

/**
 * 会话 → 模式。**阶段枚举只在这一个地方出现**——`rcAdhoc` 也要按同一个口径判
 * 「进会话 / 回到空闲」，两处各写一遍 phase 比较迟早会漏掉一个分支
 * （本文件顶部的说明就是这么来的）。
 */
export function sessionMode(session: RcSession | null | undefined): WbMainMode {
  const phase = session?.phase;
  if (!phase || phase === "idle") return "idle";
  // inbound_pending 目前后端不产出（RcSession 类型里有、Rust 侧无赋值点），
  // 但仍归到 inbound：真出现时「对方正在进来」属于被控视角，不是空闲。
  if (phase === "inbound_active" || phase === "inbound_pending") return "inbound";
  if (phase === "outbound_active") return "outbound";
  return "pending"; // outbound_pending
}

export function workbenchMainMode(status: RcStatus | null): WbMainMode {
  return sessionMode(status?.session);
}

/**
 * 是否有会话进行中。后端只有一个会话位，所以为 true 时侧栏一切「发起」都必须锁住
 * ——不锁就是摆一个点了必被 `busy_local` 拒的死项。
 */
export function isSessionActive(status: RcStatus | null): boolean {
  return workbenchMainMode(status) !== "idle";
}

/**
 * 工作台的四个导航页（v4 布局，2026-09-19）。
 * 「远程电脑」是唯一的功能主页；其余三页是同一份数据的另一种浏览方式
 * （设备列表 = 全量行 + 搜索筛选；会话记录 = 历史；设置 = 本机开关与画质）。
 */
export type WbPage = "rc" | "devices" | "history" | "settings";

/** 顶栏标题与副标题的唯一来源——导航项与顶栏必须念同一名词。 */
export const WB_PAGE_META: Record<WbPage, { title: string; hint: string }> = {
  rc: { title: "远程电脑", hint: "局域网直连 · 端到端加密" },
  devices: { title: "设备列表", hint: "全部配对设备 · 名称与指纹" },
  history: { title: "会话记录", hint: "只存本机 · 上限 20 条" },
  settings: { title: "设置", hint: "本机开关 · 被控画质" },
};
