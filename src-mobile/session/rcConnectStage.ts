import type { RcSessionPhase } from "@/lib/rcWaitStage";

/**
 * ① 连接建立阶段化（甲+乙稿，2026-10-07）：把「等画面」的三段现状映射成
 * 图标水位/步进点能画的东西。文案本体仍在 lib/rcWaitStage（两端共用口径），
 * 这里只做调用点拼装——rcWaitStage 一字不动。
 */
export interface RcConnectStage {
  /** 1=拨号 2=等批准 3=起画面；同时驱动 logo 水位（stage/3）与步进点。 */
  stage: 1 | 2 | 3;
  /** 路径胶囊短标签（直连/绕中继/局域网）；空串 = 无读数，宁缺不说。 */
  pill: string;
  /** 中继语气（warning 底色）。 */
  pillWarn: boolean;
  /** 中继专属超时话术：只在「起画面 + 绕中继 + 已过 20s 阈值」时非空。 */
  relayExtra: string;
}

export const RC_RELAY_WAIT_EXTRA = "经中继转发的连接出画面会慢一些；恢复直连后延时会自动回落。";

const STAGE_BY_PHASE: Partial<Record<RcSessionPhase, 1 | 2 | 3>> = {
  idle: 1,
  outbound_pending: 2,
  outbound_active: 3,
};

const PILL_BY_PATH: Record<string, string> = { lan: "局域网", direct: "直连", relay: "绕中继" };

/** 被控态（inbound_*）等的是「对方来控我」，不走这条发起链 → null 回退现役卡。 */
export function rcConnectStage(
  phase: RcSessionPhase | undefined | null,
  pathKind: string | undefined | null,
  waitedTooLong: boolean,
): RcConnectStage | null {
  const stage = phase == null ? 1 : STAGE_BY_PHASE[phase] ?? null;
  if (!stage) return null;
  const path = PILL_BY_PATH[pathKind ?? ""] ?? "";
  return {
    stage,
    pill: path,
    pillWarn: pathKind === "relay",
    relayExtra: stage === 3 && pathKind === "relay" && waitedTooLong ? RC_RELAY_WAIT_EXTRA : "",
  };
}
