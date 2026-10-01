/**
 * 丙-②（2026-09-30）：桌面常驻**隐私角标**的纯判断（措辞 + 计时算式）。
 *
 * 为什么单独一个文件（AGENTS.md §11.1）：角标（`RcPrivPill`）与确认卡（`RcAskPop`）
 * 是同一块置顶窗口的两种形态，两边都要把「对方拿到了什么能力」说成同一句话；
 * 计时算式则要独立于 `rcAskPop` 的那套（一个数剩余、一个数已进行，方向相反）。
 *
 * 🔴 对标 §6.2 的结论：六家没有一家靠水印遮画面，正解是**小面积常驻 + 一键终止**。
 * 所以这里只有三样东西：谁、多久了、结束。不摆画质、不摆文件、不摆任何会诱人
 * 去点玩的第二颗键。
 */
import type { RcCapability } from "./api/rcTypes";
import { rcCanControl, rcCapShort } from "@/lib/rcCapability";

/** 会话已进行的时长：`mm:ss`，过一小时升成 `h:mm:ss`。 */
export function rcPrivElapsedText(startedMs: number, nowMs: number): string {
  // 两台机器时钟不同步时差值可为负 ⇒ 钳到 0，角标上不许出现「-1:xx」
  const total = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** 角标主语：对方设备名（后端已把空名回落成设备名，这里只兜最后一个空串）。 */
export function rcPrivWhoText(displayName: string): string {
  const who = displayName.trim() || "对方";
  return `${who} 正在远程本机`;
}

/**
 * 本次会话**实际拿到**的能力（不是对方当初申请的）：与确认卡同源措辞的短版，
 * 264px 的胶囊里放不下「看屏幕 + 控制键鼠」那么长一句。
 */
export function rcPrivGrantText(cap: RcCapability): string {
  return rcCapShort(cap);
}

/** 拿到的是键鼠 ⇒ 角标用警示色（只看屏幕只是被观看，不必一路闪）。 */
export function rcPrivIsHot(cap: RcCapability): boolean {
  return rcCanControl(cap);
}
