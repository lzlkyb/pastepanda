/**
 * 远程会话「等画面」的分阶段文案（§17.3 有反馈不靠猜，两个端共用一份口径）。
 *
 * 背景（2026-10-03 真机）：手机点「远程控制」后曾出现 30 秒的静默等待——
 * 期间界面只有一句静态「等待对方画面…」，没有动画也没有阶段提示，用户
 * 分不清是在拨号、等对方批准、还是电脑在起编码器，只能判断「卡死了」。
 * 首帧之前的等待实际由后端三段构成：拨号敲门 → 等对方点「允许」→
 * 编码器选型/首帧（首次要探测硬编，秒级）。每段该说什么话，在这里说清。
 *
 * 纯函数：判据只有「会话阶段 + 已等多久」，不碰 DOM/时间源（waitingMs 由
 * 调用方给），两端（手机 RcMobileSession / 桌面 RcSessionView）各取所需。
 */

import type { RcSession } from "@/lib/api/rcTypes";

export type RcSessionPhase = RcSession["phase"];

/** 「等太久」的提示阈值（ms）。等画面不等于坏了，但超时必须有一句人话。 */
export const RC_WAIT_PENDING_HINT_MS = 30_000;
export const RC_WAIT_ACTIVE_HINT_MS = 20_000;

export interface RcWaitStage {
  /** 占位/横幅主文案：现在卡在哪一段。 */
  text: string;
  /** 等太久的一句话（空串 = 还在正常时长内，不出声）。 */
  hint: string;
}

/**
 * 分阶段等画面文案。
 *
 * - 没有会话（刚点下去还在拨号）：正在连接电脑…
 * - `outbound_pending`（敲门已送达，等对方批准）：已通知电脑，等待对方同意…
 * - `outbound_active`（批准了，编码器/首帧在起）：电脑正在准备画面…
 * - 其余（被控态 / 阶段未知）：等待对方画面…
 *
 * 等待超阈值时 `hint` 补一句人话——「等太久」和「坏了」是两回事，文案不说
 * 「异常」那种判词（真异常走 useRcFrames 的取帧失败链）。
 */
export function rcWaitStage(
  phase: RcSessionPhase | undefined | null,
  waitingMs: number,
): RcWaitStage {
  switch (phase) {
    case "outbound_pending":
      return {
        text: "已通知电脑，等待对方同意…",
        hint:
          waitingMs >= RC_WAIT_PENDING_HINT_MS
            ? "等得有点久——电脑前可能没人。等 ta 回来点「允许」，或取消重试。"
            : "",
      };
    case "outbound_active":
      return {
        text: "电脑正在准备画面…",
        hint:
          waitingMs >= RC_WAIT_ACTIVE_HINT_MS
            ? "首次连接要探测硬件编码器，稍慢；一直不出画面可尝试重连。"
            : "",
      };
    case undefined:
    case null:
    case "idle":
      // 刚点下「远程控制」、会话还没落地的拨号线
      return { text: "正在连接电脑…", hint: "" };
    default:
      // 被控态（inbound_*）等的是「对方来控我」的画面，不是这条链
      return { text: "等待对方画面…", hint: "" };
  }
}
