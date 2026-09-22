/**
 * rcWait — 等待计时的纯函数（C3：从会话 started_ms 起算，中途重挂不归零）。
 *
 * 之前用组件 mount 时间当起点：pending 中关掉再打开对话框，计数会归零
 * （已等 3 分钟却显示 0 秒）。改成以会话 started_ms 为基准，组件重新挂载
 * 只是 now 继续前进，起点不变 → 单调不减、不归零。
 */

/**
 * 已等待毫秒数。
 * @param startedMs 会话/申请开始时间戳（ms），可能为 null/undefined/0
 * @param now 当前时间戳（ms）
 * @returns 已等待毫秒（已钳到 ≥0）
 */
export function waitedMs(startedMs: number | null | undefined, now: number): number {
  if (startedMs == null || startedMs <= 0) return 0;
  return Math.max(0, now - startedMs);
}

/**
 * 对端人工确认窗口（ms）。**与后端对齐**：`src-tauri/src/rc/service.rs:2138`
 * 被控端收到申请后 `deadline = now_ms() + 120_000`，超时以 `confirm_timeout`
 * 拒绝（前端文案见 `lib/rcDeny.ts`）。
 *
 * 🔴 这个常量只用于**显示**倒计时，绝不驱动取消：取消是**对端**的行为，本机提前
 * 自己收尾会和对端状态机打架（对端仍会在 120s 时 deny，本机已经断过一版）。
 * 另一个已知偏差：本机起点是申请**发出**时刻，对端是**收到**时刻，中间那几秒
 * 拨号时间（绕中继可能 1~3s）让本机倒计时略早——所以归零后不能说「已取消」，
 * 只能显示「正在收尾」。
 */
export const WAIT_CONFIRM_MS = 120_000;

/**
 * 剩余确认时间（ms）；`null` = 起点不可用。
 * 起点不可用时宁可不说，也不按 mount 时间编一个（C3 的老坑）。
 */
export function waitRemainingMs(
  startedMs: number | null | undefined,
  now: number,
  limitMs: number = WAIT_CONFIRM_MS,
): number | null {
  if (startedMs == null || startedMs <= 0) return null;
  return Math.max(0, limitMs - Math.max(0, now - startedMs));
}

/**
 * 等待进度 0..1；`null` = 起点不可用（用它决定进度条渲不渲染）。
 */
export function waitProgress(
  startedMs: number | null | undefined,
  now: number,
  limitMs: number = WAIT_CONFIRM_MS,
): number | null {
  if (limitMs <= 0) return null;
  const rest = waitRemainingMs(startedMs, now, limitMs);
  if (rest === null) return null;
  return Math.min(1, Math.max(0, 1 - rest / limitMs));
}

/**
 * 中文时长，向上取整：「12 秒」「1 分 48 秒」「2 分」。
 * 取整方向选 ceil 是为了不出现「0 秒后自动取消」——只要还剩一滴就说得出来。
 */
export function formatWaitSpan(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m <= 0) return `${sec} 秒`;
  return sec === 0 ? `${m} 分` : `${m} 分 ${sec} 秒`;
}
