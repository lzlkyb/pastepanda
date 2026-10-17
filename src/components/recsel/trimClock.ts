/**
 * 裁剪时间轴上的读数：`mm:ss.t`。
 *
 * 为什么不用 `formatRecordingPosition`（那是 `mm:ss.mmm`）：拖拽手柄的落点由关键帧吸附
 * 决定，报到毫秒是假精度；而且两枚芯片在窄窗里最先被截断的正好是最右边的数字
 * （`00:03.200` 有 9 个字符，去掉两个 0 直接看得见秒）。
 *
 * 秒表本体沿用 `formatRecordingTime`：它会按需补上位（≥1 小时才出现 `hh:`），
 * 与结果卡、控制条读数是同一套读法。
 */
import { formatRecordingTime } from "@/lib/utils";

/** 秒表刻度只保留到十分之一秒，且**截断**：四舍五入会把 00:03.96 显示成 00:04.0，
 *  读数反而比手柄实际位置靠后——读数只要比真实位置小，用户不会觉得「拖了没动」。 */
export function trimClock(ms: number): string {
  const value = Math.max(0, Number.isFinite(ms) ? ms : 0);
  return `${formatRecordingTime(value)}.${Math.floor((value % 1000) / 100)}`;
}
