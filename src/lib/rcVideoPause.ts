/**
 * rcVideoPause — 丙-③「暂停对方观看」的措辞与判据唯一真源（规则 11.1）。
 *
 * 这条按钮改的是「对方能不能看见我的屏幕」，安全语义，所以措辞是硬约束：
 * - **不许写成「已断开」**：会话、键鼠、剪贴板、文件通道全都照常通，只有画面停帧；
 * - **不许写成「黑屏」**：对方看到的是暂停前那一帧，不是黑（黑屏是另一条机制，
 *   已在拍板时被否掉，理由见 `docs/远程电脑-交互审计与方案-2026-09-29.md` §12.6）；
 * - 被控端侧要说清**只在这一场有效**：跨会话留着暂停，下一场对方一进来就看见
 *   一张冻住的旧画面，只会以为是链路坏了。
 *
 * 状态真源全在后端（`status.video_paused` / `status.peer_video_paused`），这里只管
 * 出话，不存状态——与 `rcInputGate.ts` 同一分工。
 */

/** 被控端抽屉里那颗暂停/恢复键。 */
export function rcPauseButtonOf(paused: boolean): {
  on: boolean;
  label: string;
  tip: string;
} {
  return {
    on: paused,
    label: paused ? "恢复对方观看" : "暂停对方观看",
    tip: paused
      ? "对方现在看到的是暂停前那一帧（会话没断：你照样能用这台电脑，对方照样能操作键鼠、传剪贴板）。点此恢复推送。"
      : "立刻停止向对方推送画面，他那边停在当前这一帧。会话不断——挡的是对方的眼睛，不是他的手（要拦键鼠请用「暂时收回我的键鼠」）。只在这一场会话有效，结束会话自动恢复。",
  };
}

/**
 * 被控端胶囊行的常驻徽标（点它直接恢复，不用再把抽屉开一遍）。
 *
 * 规则 15.1：触发在抽屉里、状态却常驻成立，那状态就得有个不靠抽屉的落点。
 */
export function rcPauseBadgeOf(paused: boolean): string | null {
  return paused ? "画面已暂停·点此恢复" : null;
}

/**
 * 发起端看到的「对方暂停了画面」。
 *
 * 🔴 旧对端不发这条帧 ⇒ 恒 null：没有证据就不摆断言（与「对方已静音」同一纪律）。
 */
export function rcPeerPausedPillOf(peerPaused: boolean | null | undefined): string | null {
  return peerPaused ? "对方已暂停画面" : null;
}

/** 发起端出口条那行常驻说明（浮条收起时它还在）。 */
export function rcPeerPausedOutletOf(peerPaused: boolean | null | undefined): {
  label: string;
  detail: string;
} | null {
  if (!peerPaused) return null;
  return {
    label: "对方暂停了画面",
    detail: "你看到的是他暂停前那一帧；键鼠与剪贴板照常，他恢复后画面继续。",
  };
}
