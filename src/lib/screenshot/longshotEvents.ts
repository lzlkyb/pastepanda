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

/** 状态窗实时长图预览的固定宽度（CSS px）。
 *  主窗按它缩放增量条、状态窗画布用同一个内部宽度 —— 两边不用再协商尺寸，
 *  也保证 1:1 不重采样。改它必须同步改 screenshot.rs 的 LONGSHOT_W（= 它 + 两边 padding）。 */
export const LONGSHOT_STRIP_W = 400;
/** 实时长图预览区高度（CSS px）。只显示**尾部** —— 用户最关心的是刚拼上的那一屏对不对。 */
export const LONGSHOT_PREVIEW_H = 176;

/**
 * 拼接质量（学 ShareX 的绿/黄/红三档）。
 *
 * 为什么需要它：重叠匹配本质上是猜。旧实现只有「成功出图」与「失败」两档，
 * 中间那大片「拼出来了但接缝不一定对」的情况全被当成成功 —— 用户拿到一张
 * 错位的长图却以为一切正常。把不确定性摊开说，用户才知道要不要重截。
 * - ok：每帧都找到了充分的重叠
 * - warn：有帧只勉强对上，或没滚到底就因为屏数/时长上限收尾
 * - bad：根本没拼成（只有一屏 / 重叠匹配异常）
 */
export type LongShotQuality = "ok" | "warn" | "bad";

export interface LongShotProgress {
  /** 已拼接的帧数 */
  frames: number;
  /** 已拼接的总高（物理像素） */
  height: number;
  /** 最新一帧的缩略图 dataURL（已缩到 26×40，编码成本可忽略） */
  thumb: string | null;
  /**
   * 本帧**新增**那一段像素的窄条缩略（dataURL，宽度已统一到 LONGSHOT_STRIP_W）。
   * 状态窗按到达顺序往下追加，就得到一张实时生长的长图预览。
   *
   * ❌ 为什么发**增量**而不是整张长图：整图高度随帧数线性增长，每帧重编码一次
   * 就是 O(n²)，拼到十几屏时每帧几十毫秒全花在 toDataURL 上，直接拖慢拼接主循环。
   * 发增量则每帧成本恒定。
   */
  strip?: string;
  /** 当前拼接质量（不传 = ok）。状态窗用它显示一个三色点，实时告诉用户拼得靠不靠谱。 */
  quality?: LongShotQuality;
  /**
   * 可选状态提示（如「该区域不响应滚动」）：主窗已隐藏，toast 用户看不到，
   * 必须随进度事件带到**可见**的状态窗上显示（ls-sub 行）。
   */
  note?: string;
}

/**
 * stop 与 abort 语义必须分开：
 * - stop：停下来，用**已拼的内容**出图
 * - abort：放弃，什么都不留
 * 旧实现只有 abort（而且还是个没人能触发的死功能），用户想"就拼到这里"时无路可走。
 * UI 上分别叫「完成」（Enter）与「取消」（Esc），对齐微信 PC 版。
 *
 * ❌ 曾经还有 next / mode_auto / mode_manual，随自动滚动一起砍了：
 * 现在用户自己滚、软件实时拼，既不需要选模式，也不需要逐屏点「下一张」。
 */
export type LongShotControl = "stop" | "abort";
