/**
 * rcWindow — 远程电脑的窗口级小工具。
 *
 * 只有一个函数，但它是**两处**常驻层的共同前置：`RcOverlay`（会话/敲门请求）
 * 与 `RcFileOverlay`（文件请求）。两者都需要它，所以不能各自私有一份——
 * 「有时限的入站请求要主动亮出窗口」这条行为只该有一个实现。
 */

/**
 * 把主窗口拉到前台（show + focus）。
 *
 * 用在「有时限的请求」上：窗口 hidden/失焦时用户看不见 toast，而这类请求都有
 * 超时（远程申请 120s、文件请求 60s），超时即视为拒绝——不主动亮出来，
 * 用户根本不知道自己错过了一次。
 */
export async function summonMainWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (!(await w.isVisible())) await w.show();
    await w.setFocus();
  } catch {
    /* 非 Tauri 或权限不足时忽略 */
  }
}
