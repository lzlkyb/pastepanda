/**
 * 长截图主窗口 ↔ 状态小窗的事件契约。
 *
 * 为什么走事件而不是共享状态：两者是两个独立的 WebView，没有共同内存。
 *
 * 为什么这条链路可靠：长截图期间截图窗口被 hide()，隐藏的 WebView 收不到
 * 任何**输入事件**（这正是旧的"Esc 中止长截图"一直是死功能的原因），
 * 但它仍能执行 JS 与收发 IPC 事件 —— 长截图循环本身就在隐藏期间跑并持续
 * invoke 后端，这一点已被现有代码证明。
 */

/** 主窗 → 状态窗：每拼一帧上报一次 */
export const LONGSHOT_PROGRESS = "longshot-progress";
/** 状态窗 → 主窗：用户点了停止或放弃 */
export const LONGSHOT_CONTROL = "longshot-control";

export interface LongShotProgress {
  /** 已拼接的帧数 */
  frames: number;
  /** 已拼接的总高（物理像素） */
  height: number;
  /** 最新一帧的缩略图 dataURL（已缩到 26×40，编码成本可忽略） */
  thumb: string | null;
}

/**
 * stop 与 abort 语义必须分开：
 * - stop：停下来，用**已拼的内容**出图
 * - abort：放弃，什么都不留
 * 旧实现只有 abort（而且还是个没人能触发的死功能），用户想"就拼到这里"时无路可走。
 */
/**
 * stop 与 abort 语义必须分开：
 * - stop：停下来，用**已拼的内容**出图
 * - abort：放弃，什么都不留
 * 旧实现只有 abort（而且还是个没人能触发的死功能），用户想"就拼到这里"时无路可走。
 *
 * 长截图扩展（手动滚动模式）：
 * - next：手动模式专用，用户「已向下滚动一屏」后点「下一张」，触发主窗截下一帧
 * - mode_auto / mode_manual：切换自动滚动 / 手动滚动模式（可在长截图进行中动态切换）
 */
export type LongShotControl = "stop" | "abort" | "next" | "mode_auto" | "mode_manual";
