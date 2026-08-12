/**
 * lib/aiBudgetMsg.ts —— 审查：预算超限文案唯一出处。
 * 曾散在 aiTransforms / AiActionEditor 等多处且措辞不一，统一在这里。
 */

/** 预算超限提示文案（spentCny/budgetCny：人民币，后端 ai_run 已换算） */
export function budgetExceededMessage(spentCny: number, budgetCny: number): string {
  return `今日 AI 花费已达上限（约 ¥${spentCny.toFixed(2)} / ¥${budgetCny.toFixed(2)}），可在设置 → AI 里调高`;
}
