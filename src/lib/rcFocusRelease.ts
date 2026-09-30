/**
 * rcFocusRelease — 焦点离开画面时「要不要松开按住键」的判据（乙-②，2026-09-30）。
 *
 * 缺陷原样（审计 C4）：按住 Ctrl 去点胶囊上的「画质」下拉 → 画面 `onBlur` 无条件
 * 释放全部按住键 + 清空按下态跟踪 → 回到画面还得再点一次才重新捕获键盘。用户读到
 * 的是「我按住了，它自己松了」。根因是把**同窗内的焦点切换**当成了**跨应用失焦**。
 *
 * 两条路径必须分开（这是本档唯一的风险申报）：
 * - 焦点进浮条（同窗、还在会话壳里）＝**只暂停注入**。按住态留着，焦点回画面自然续上
 *   ——语义与浏览器自己处理元素间焦点一致。
 * - 焦点离开会话壳（切到别的窗口 / 别的屏幕外的本机 UI / 拿不到新焦点）＝**释放**。
 *   否则画面被最小化时对端可能永久留着 Ctrl（那才是真事故）。
 *
 * 会话结束、按 Esc 释放键盘、卸载兜底这三条**不受本文件影响**，它们照旧全量清。
 */

export type RcBlurTarget = "inside_session" | "outside";

/**
 * 事件给的新焦点落在会话壳（`.sessionWrap`，也是全屏元素）**内部** ⇒ `inside_session`。
 * `relatedTarget` 为 null 在 Chromium 里就是「窗口整体失去焦点」（Alt-Tab / 最小化），
 * 归 `outside`——这正是必须释放按住态的那一类。
 */
export function rcBlurTarget(
  relatedTarget: EventTarget | null,
  wrap: HTMLElement | null,
): RcBlurTarget {
  if (!wrap) return "outside";
  if (!(relatedTarget instanceof Node)) return "outside";
  return wrap.contains(relatedTarget) ? "inside_session" : "outside";
}

/** 只有离开会话壳才释放按住键/鼠标键（同窗内切换只暂停注入）。 */
export function rcBlurReleasesHeld(target: RcBlurTarget): boolean {
  return target !== "inside_session";
}
