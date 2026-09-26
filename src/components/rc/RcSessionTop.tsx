/**
 * RcSessionTop — 会话顶栏：**纯窗口壳**（灯 / 名字 / 窗口三键）。
 *
 * 🔴 连接灯只由 `linkState` 驱动（对端 pong 的新鲜度），**不再看画面停滞**。
 * 橙 = 「等等就好」（不稳/重连中），红 = 「需要动手」（failed），两档刻意分开。
 *
 * 2026-09-24 控端态浮条收编：能力胶囊 / 链路与旧版警示 / 重连 / 结束会话 / 更多
 * 全部搬进 RcSessionCapsule（画面顶部居中、会隐藏的深色胶囊）——顶栏从此不再
 * 与浮条抢地盘，本条只剩窗口壳职责：链路状态灯 + 对方名字 + 拖拽区 + 三键。
 *
 * 拖拽：`data-tauri-drag-region="deep"`——与 md 全屏编辑器（FullscreenShell
 * 的工具栏）**完全同款**：整条子树可拖、按钮自动豁免、双击最大化由 Tauri
 * 注入脚本内置（`internal_toggle_maximize`）。批7 引入；方案A 草案曾换成 JS
 * startDragging，用户复核后定稿回到编辑器同款机制——「拖不动」是拖拽位置
 * 习惯问题（用户抓了胶囊/画面），不是机制失效。三键仍走 Rust 命令出口
 * （lib/rcWindowOps，见 RcWindowControls 文件头）。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcSession } from "@/lib/api/rc";
import type { RcLinkState } from "@/lib/rcSessionStats";
import { RcWindowControls } from "./RcWindowControls";
import styles from "./RemoteComputer.module.css";

export function RcSessionTop({
  session,
  linkState,
  fullscreen,
  hideWindowControls = false,
}: {
  session: RcSession;
  linkState: RcLinkState;
  /** 会话壳全屏中——顶条此时是画面顶边，禁用拖窗（拖拽区会牵动窗口）。 */
  fullscreen?: boolean;
  /**
   * 🔴 再审计（全屏双组三键，2026-09-25）：全屏态顶条与 RcFullscreenHotbar 的
   * 窗口三键同屏两份——设计稿意图是全屏只用 hotbar 右上角三键（Windows 习惯位，
   * 关闭键贴屏幕右上角）。只在全屏传 true 隐藏顶条三键，非全屏行为不变。
   */
  hideWindowControls?: boolean;
}) {
  const dotCls =
    linkState === "connected"
      ? styles.live
      : linkState === "failed"
        ? styles.liveBad
        : styles.liveOff;
  return (
    /* 批7：会话态整条工作台标题栏被 `hidesWorkbenchTitleBar` 收掉（画面铺满），
       而没有标题栏的窗口既拖不动也关不掉——本条兼作拖拽区（md 全屏编辑器同款
       `deep`，见文件头）。`deep` 让整个子树可拖，条内的三键由 Tauri 自动豁免。 */
    <div
      className={styles.viewTop}
      data-tauri-drag-region={fullscreen ? "false" : "deep"}
    >
      <span className={dotCls} />
      <span>
        正在查看 <b>{rcDisplayName(session, fingerprintOf(session.peer))}</b>
      </span>
      <span className={styles.sp} />
      {/* 方案 A/B（2026-09-24）：完整三键组，走 rc_window_close 命令（close 语义，
          不 destroy），「有会话先问」的守卫不变。全屏态隐藏（hotbar 右上角有
          同语义三键，见 hideWindowControls 注释），避免同屏双组。 */}
      {!hideWindowControls && (
        <div className={styles.winControlsFlush} data-tauri-drag-region="false">
          <RcWindowControls />
        </div>
      )}
    </div>
  );
}
