/**
 * recsel/trimSnap.ts — 预览裁剪时间轴的吸附纯函数。
 *
 * 与后端 `rec/trim.rs` 的 `snap` **同一规则**（宁多勿少）：入点向下吸关键帧、
 * 出点向上吸关键帧；无可吸时取 0 / 时长。后端 rec_trim 会再吸一次（权威），
 * 这里吸是为了 UI 展示的入出点与实际产物一致，两处规则必须同步改。
 */

export interface TrimRange {
  inMs: number;
  outMs: number;
}

/** 归一 + 关键帧吸附（宁多勿少）：保留段 ⊇ 用户选段。 */
export function snapTrimRange(
  keyframesMs: number[],
  durationMs: number,
  inMs: number,
  outMs: number,
): TrimRange {
  const inM = Math.min(inMs, outMs);
  const outM = Math.min(Math.max(outMs, inMs), durationMs);
  if (keyframesMs.length === 0) return { inMs: inM, outMs: outM };
  let kfIn = 0;
  for (const k of keyframesMs) if (k <= inM && k > kfIn) kfIn = k;
  let kfOut = durationMs;
  for (const k of keyframesMs) if (k >= outM && k < kfOut) kfOut = k;
  return { inMs: kfIn, outMs: Math.max(kfOut, kfIn) };
}
