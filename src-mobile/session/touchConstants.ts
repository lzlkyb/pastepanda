/**
 * 触摸语义阈值常数（design/远程电脑-手机端-触摸语义与坐标系-设计稿-2026-09-29 §1）。
 *
 * 集中一处的原因：这些值决定「手感」，实测调参时会频繁动它们；
 * 分散在状态机/输入层里必然漂移。数值为业界常用值，标注了依据。
 */

/** 点按/长按允许的最大位移（≈3mm，防手抖误判为拖动）。 */
export const TAP_MAX_PX = 12;
/**
 * 长按充能时长。高于 Android 系统长按 400ms，避免与 WebView 自带长按行为
 * （文本选择/上下文菜单）竞争——我们同时用 touch-action:none + preventDefault 关掉它们。
 */
export const LONG_PRESS_MS = 550;
/** 双击：两次点按的间隔上限（远端 Windows DoubleClickTime=500ms 内能收到）。 */
export const DBL_TAP_MS = 320;
/** 双击：两次点按的位置接近度上限。 */
export const DBL_TAP_PX = 24;
/** 双指手势分类的噪声地板：位移低于此值不判定主导量（防抖动误分类）。 */
export const TWO_FINGER_CLASSIFY_PX = 10;
/** 等待另一指的事件；一指保持不动时仍可捏合，不无限等第二指。 */
export const TWO_FINGER_SETTLE_MS = 48;
/** 捏合主导判据：|Δ间距| > 1.4×|Δ中点| → 捏合，否则滚动。 */
export const PINCH_DOMINANCE = 1.4;
/** 滚轮量化：双指每累积这么多 CSS 像素发一档 ±120（Windows WHEEL_DELTA）。 */
export const SCROLL_NOTCH_PX = 64;
/** 单次 flush 最多档数：防极限甩动瞬间洪泛可靠流。 */
export const SCROLL_MAX_NOTCHES = 3;
/** 滚轮合并发送窗口（桌面 useRcInput 同口径 16ms）。 */
export const WHEEL_MERGE_MS = 16;
/** 指针移动节流（桌面 useRcInput 同口径 16ms；绝对坐标 latest-wins）。 */
export const MOVE_THROTTLE_MS = 16;
/**
 * 点按前预发自移 + 悬停消化时长。桌面语义 = 先移动再点击：不少控件
 * （hover 菜单/自定义绘制/UWP）对「没有悬停过程的点击」不响应——真机
 * 联调 2026-10-01 用户报「tap 别处鼠标不过去、点击没用」的根因。
 * 60ms 远低于人的点击感知阈值（~100ms），观感仍是「即点即有」。
 */
export const CLICK_HOVER_MS = 60;
/** 本地视野缩放范围（design §1 手势⑦）。 */
export const PINCH_MIN = 0.5;
export const PINCH_MAX = 4;
