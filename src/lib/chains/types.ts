/**
 * chains/types.ts — 动作链的类型定义（X1 · 可保存的"粘贴动作链"）。
 *
 * 链 = 有序的变换步骤。上一步的输出作为下一步的输入，线性执行（首版不做分支画布）。
 * 每步标注 risk：local（纯本地）/ network（联网）/ destructive（修改性，如脱敏）。
 * 设计对齐 docs/功能清单-v6.x.md 的 X1 规划：失败定位到步骤、失败保留原始内容。
 */

/** 步骤风险等级。UI 据此显示徽标，提示用户"这一步会做什么"。 */
export type ChainStepRisk = "local" | "network" | "destructive";

/** 步骤执行条件（v6.3 条件执行）：不满足时该步跳过（输出 = 输入，原样传递）。 */
export type ChainStepConditionType = "always" | "is-json" | "contains-secret" | "is-code";

/** 条件定义。type 说明见 {@link matchesCondition}。 */
export interface ChainStepCondition {
  type: ChainStepConditionType;
}

/** 链中的一个步骤：引用一个已注册变换（transforms/registry） */
export interface ChainStep {
  transformId: string;
  risk: ChainStepRisk;
  /** 覆盖显示名；缺省用变换自身的 label */
  label?: string;
  /** v6.3 条件执行：缺省 = always（无条件执行） */
  condition?: ChainStepCondition;
}

/** 一条链的定义 */
export interface Chain {
  id: string;
  name: string;
  description: string;
  steps: ChainStep[];
  /**
   * 步骤配置已损坏（后端解析 `steps` 失败）。
   *
   * 与“真的是空链”必须分开：两者的 `steps` 都是 `[]`，但前者是数据丢了
   * （用户原本配过步骤），后者是用户本来就没配。提示文案不能一样。
   */
  corrupted?: boolean;
  /** 损坏时的原始 JSON（给用户照着重建） */
  rawSteps?: string;
}

/** 单步执行结果（供逐步预览） */
export interface ChainRunStage {
  stepIndex: number;
  transformId: string;
  label: string;
  risk: ChainStepRisk;
  /** 该步的输入（上一步的输出） */
  input: string;
  output: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  /** v6.3：条件不满足被跳过（ok=true，output=输入） */
  skipped?: boolean;
}

/** 整条链的运行结果 */
export interface ChainRunResult {
  ok: boolean;
  stages: ChainRunStage[];
  /**
   * 最终输出。失败时 = 最后一个成功步骤的输出（"失败保留原文，不静默粘半成品"，
   * 但不把原始内容扔掉——用户仍可复制这个中间产物）。
   */
  final: string;
  /** 失败步骤的索引（0 起）；成功时为 undefined */
  failedAt?: number;
}
