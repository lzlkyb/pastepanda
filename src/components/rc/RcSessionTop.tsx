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
 * 2026-09-28 方案 A：全屏态**整条不渲染**（裁决在 RcSessionStage）——身份与窗口键
 * 都在胶囊里，顶栏再留一条就是白吃 36px 画面高度。于是本组件不再有全屏分支，
 * 原先的 `fullscreen` / `hideWindowControls` 两个 prop 一并删除。
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
}: {
  session: RcSession;
  linkState: RcLinkState;
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
    <div className={styles.viewTop} data-tauri-drag-region="deep">
      <span className={dotCls} />
      <span>
        正在查看 <b>{rcDisplayName(session, fingerprintOf(session.peer))}</b>
      </span>
      <span className={styles.sp} />
      {/* 方案 A/B（2026-09-24）：完整三键组，走 rc_window_close 命令（close 语义，
          不 destroy），「有会话先问」的守卫不变。全屏态整条不渲染（见文件头）。 */}
      <div className={styles.winControlsFlush} data-tauri-drag-region="false">
        <RcWindowControls />
      </div>
    </div>
  );
}
