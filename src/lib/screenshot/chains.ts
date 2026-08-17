/**
 * 动作链在截图场景下的门控判据。
 *
 * 单独成文件是因为它有两个调用方（弹层的置灰渲染 + runChainAction 的二道防线），
 * 两边必须用同一个判据——否则会出现「看着可点却被拦」或反过来的不一致。
 */

import type { ChainDef } from "@/lib/api/chains";

/**
 * 链里有没有会把内容发到云端的步骤。
 *
 * 判据沿用 chains/registry 的 riskOf（remote → "network"），不在这里另写一套（规则 11.1）。
 * 纯本地链（全是 local 步骤）不受 AI 开关约束——规则 16 第 4 条明说本地能力不算 AI 功能。
 */
export function chainNeedsAi(c: ChainDef): boolean {
  return c.steps.some((s) => s.risk === "network");
}
