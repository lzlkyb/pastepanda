/**
 * rcPanelFocus — 会话内「浮层面板展开中」的模块级计数器（2026-09-25，Esc 两级取消）。
 *
 * 问题：useRcInput 的 window 级 Esc 兜底只豁免 `.dialog-backdrop`——画质/画面
 * 下拉（RcDropdown）、⋯ 面板（RcCapsuleMore，moreOpen）、连接详情（RcHud，open）
 * 展开时按 Esc 会**直落「结束会话」确认**，违反两级取消（规则 17.6：Esc 先回
 * 上一步——这里的第一级是「收起面板」——再 Esc 才退出）。
 *
 * 收口方式：面板展开时 register、收起/卸载时 unregister（都写在 effect 与其
 * cleanup 里，天然配对，StrictMode 双挂载也平衡）；useRcInput 的 Esc 兜底在
 * 计数 >0 时直接让路，由各面板自己的 keydown 收起自己。
 *
 * 为什么是模块级而不是 React 状态：useRcInput 的监听挂在 window 上，与三个
 * 面板分属不同组件树分支，走 props/context 要改 4 个组件的接口；而它只是
 * 「Esc 让不让路」的同步判断，没有渲染语义。作用域是每 WebView 单例
 * （与 rcStore 同口径；本项目辅助窗口关闭走 hide 不销毁 WebView，不串）。
 */

let openCount = 0;

/** 面板展开时调用（必须在 effect 内，与 cleanup 的 unregister 严格配对）。 */
export function registerRcPanel(): void {
  openCount += 1;
}

/** 面板收起/卸载时调用（effect cleanup）。 */
export function unregisterRcPanel(): void {
  // 防御负数：多退一次只会让计数失真为「无面板」，Esc 兜底重新接管——
  // 比卡在「有面板」更安全（后者会让 Esc 永久失效）。
  openCount = Math.max(0, openCount - 1);
}

/** 当前展开中的面板数（0 = 无面板，Esc 兜底可走结束确认）。 */
export function rcPanelOpenCount(): number {
  return openCount;
}
