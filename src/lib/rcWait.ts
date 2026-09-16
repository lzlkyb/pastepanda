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
