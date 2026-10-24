/**
 * resolveStackCaptureNotice —— 栈模式下「复制入栈」该不该弹提示的唯一决策点。
 *
 * 🔴 批次②（通知治理 · 方案 A，2026-10-24）：改前栈模式下**每一次 Ctrl+C**
 * 都弹一条「入栈 N 条」——这是全应用唯一"用户没在本应用里操作也弹"的
 * 高频被动通知，是「通知频繁打扰」的第二根因。
 *
 * 新口径（本文件钉死）：
 * - **常规入栈（含整表成功拆行）默认零提示**——栈浮标/栈横幅的条数变化就是反馈；
 *   想要文字确认的用户可开 `stack_capture_toast` 开关。
 * - **异常恒提示**（不受开关控制，因为它们是要动手的信号）：
 *   栈满导致表格没拆、表格只放进一部分、看着像表格但没拆开。
 */
export interface StackCaptureNoticeInput {
  stackMode: boolean;
  /** 设置页「复制入栈提示」开关（config.stack_capture_toast，默认关）。 */
  captureToastEnabled: boolean;
  /** config.table_split_enabled。 */
  tableSplitEnabled: boolean;
  /** stackPushOrSplit 的拆分结果；null = 没走拆分（普通整条入栈）。 */
  split: { totalRows: number; splitCount: number } | null;
  /** 本次入栈净增条数（0 = 栈满/重复，一条都没进）。 */
  grewBy: number;
  /** 内容看着像表格但没被拆开（只统计 grewBy > 0 时的值）。 */
  unsplitTableLike: boolean;
  /** 当前生效的栈容量（resolveStackMaxItems 的值）。 */
  stackCap: number;
}

export function resolveStackCaptureNotice(i: StackCaptureNoticeInput): string | null {
  if (!i.stackMode) return null;
  if (i.split) {
    // 异常三连：栈满没拆 / 只放进部分——恒提示（用户下一步该去粘掉几条）
    if (i.split.splitCount === 0)
      return `栈已满 ${i.stackCap} 条，表格没拆——先粘掉几条再复制`;
    if (i.split.totalRows > i.split.splitCount)
      return `表格 ${i.split.totalRows} 行，只放进前 ${i.split.splitCount} 条（栈上限 ${i.stackCap}）`;
    return i.captureToastEnabled ? `已按行拆 ${i.split.splitCount} 条入栈` : null;
  }
  if (i.grewBy <= 0) return null;
  if (i.unsplitTableLike)
    return "看着像表格，但没能按行拆开——已整条入栈";
  return i.captureToastEnabled ? `入栈 ${i.grewBy} 条` : null;
}
