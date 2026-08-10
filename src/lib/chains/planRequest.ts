/**
 * chains/planRequest.ts —— AI 编链（B）的请求编排。
 *
 * 把“收集可用动作 → 调后端 → 解析 → 白名单校验”收在一处，
 * 调用方（变换枢纽）只面对一个 {@link PlanOutcome} 分支。
 *
 * 不把这些写进组件的理由：`TransformHubDialog` 已经 375 行（规则 #7 上限 300），
 * 而这段逻辑与 UI 无关、且以后可能多处复用（卡片右键、建议条）。
 */

import { listTransforms } from "@/lib/transforms/registry";
import { aiPlanChain } from "@/lib/api/ai";
import { parseChainPlan, plannedToChain } from "./planner";
import type { Chain } from "./types";

/** 编链结果。前三态与 `aiRun` 一致，`unusable` 是本模块特有的。 */
export type PlanOutcome =
  | {
      status: "ok";
      chain: Chain;
      /** 模型提了但被白名单丢弃的 id（要告诉用户，不能静默） */
      dropped: string[];
      /** 模型输出被 token 上限截断——链可能不完整 */
      truncated: boolean;
    }
  | { status: "needsConfirm"; reason: string }
  | { status: "budgetExceeded"; spentCny: number; budgetCny: number }
  /**
   * 模型返了东西，但**一步可用步骤都没有**（解析失败，或全是编造/执行类 id）。
   * 单独一态而不当错误：这不是故障，是“它没想出来”，文案得不一样。
   */
  | { status: "unusable" };

/**
 * 让模型给当前内容编一条链。
 *
 * @param force 用户已在敏感内容提示上确认过时传 true
 */
export async function requestPlannedChain(
  text: string,
  force?: boolean,
): Promise<PlanOutcome> {
  // 排除执行类：它们产生副作用而不产出文本，本来就不能当链的步骤。
  // planner 那边也会再拦一道（输入来自模型，不能只靠这里），
  // 但不把它们放进清单能省一大截 prompt，也少一个误导模型的机会。
  const actions = listTransforms()
    .filter((t) => t.kind !== "action")
    .map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description ?? "",
    }));

  const res = await aiPlanChain(text, actions, force);

  if (res.status === "needsConfirm") {
    return { status: "needsConfirm", reason: res.reason };
  }
  if (res.status === "budgetExceeded") {
    return {
      status: "budgetExceeded",
      spentCny: res.spentCny,
      budgetCny: res.budgetCny,
    };
  }

  const planned = parseChainPlan(res.content);
  if (!planned) return { status: "unusable" };

  return {
    status: "ok",
    chain: plannedToChain(planned),
    dropped: planned.dropped,
    truncated: res.truncated ?? false,
  };
}
