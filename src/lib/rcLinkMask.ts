/**
 * rcLinkMask — 断连遮罩 + 一级重连的**判据**（甲-③④，2026-09-29）。
 *
 * 遮罩要回答的只有一个问题：现在屏幕上该说「正在尝试恢复」还是「需要对方重新同意」。
 * 判据单列成纯函数（同 `rcOutlet` 的分法），守卫单测钉住表，别在 JSX 里写三元。
 *
 * 三条边界：
 * - **没有画面就不遮**：一帧都没等到时 `RcSessionStage` 的 placeholder 已经在说话，
 *   遮罩再盖一层就是两条互不相干的错误文案。
 * - 只有 `reconnecting` / `failed` 遮。`unstable`（网络抖动）不遮——它会自愈，
 *   铺一层半透明黑会把「还能用」这件事说成「已经断了」。
 * - 说「需要对方重新同意」是真话：重连用尽（`gave_up`）后 episode 交给用户手动
 *   「重新发起」，那一趟会再敲一次对方的门（免确认设备在线才免确认）。
 */
import type { RcLinkState } from "@/lib/rcSessionStats";

export type RcLinkMaskPhase = "recovering" | "consent";

export function rcLinkMaskPhase(a: {
  hasFrame: boolean;
  state: RcLinkState;
  /** 重连等在途（`rc.busy`）。 */
  busy: boolean;
}): RcLinkMaskPhase | null {
  if (!a.hasFrame) return null;
  if (a.state === "reconnecting") return "recovering";
  if (a.state !== "failed") return null;
  // 判死时只有在途重连才谈得上「恢复」；否则这条连接已经结束了
  return a.busy ? "recovering" : "consent";
}

/**
 * 甲-④（一级项重排）：一级「立即重连」的出现条件。
 *
 * 「中断态」= 链路已经活着但正在掉/掉定了（unstable / reconnecting / failed）。
 * `connecting` 不算——那是首次建链，placeholder 已经在说话，此时摆主按钮会让人
 * 以为点它能加速。正常态不占宽是这档改动的硬约束（几何申报：最坏 +96px）。
 */
export function rcReconnectPrimaryOf(state: RcLinkState): boolean {
  return state === "unstable" || state === "reconnecting" || state === "failed";
}

/**
 * 乙-⑤（2026-09-29，待拍板⑤）：自动重连 episode 结束后的**结果**判据。
 *
 * 为什么要在前端认这一步：episode 一成功，`reconnecting` 就清空，遮罩与顶栏横幅
 * 同时消失——用户看到的是「它自己没了」，而不是「回来了」（规则 15.1：触发常驻可见，
 * 结果就得常驻可见）。三条都得成立才算「已恢复」：
 * - 上一帧还在重连、这一帧没了 → episode 交棒；
 * - 上一帧不是 `gave_up` → 用尽那一支由横幅常驻说明，别再弹一条「已恢复」的假话；
 * - **此刻这台对端真有会话** → 手动结束会话同样会清空 episode，那种情况 `session` 为空。
 */
export function rcReconnectRecoveredOf(a: {
  prev: { peer: string; gave_up: boolean } | null | undefined;
  now: { peer: string; gave_up: boolean } | null | undefined;
  livePeer: string | null | undefined;
}): boolean {
  if (!a.prev || a.prev.gave_up || a.now) return false;
  return !!a.livePeer && a.livePeer === a.prev.peer;
}
