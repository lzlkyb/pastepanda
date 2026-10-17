import { getTransform } from "@/lib/transforms/registry";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { matchesCondition } from "./conditions";
import type { Chain, ChainRunControl, ChainRunResult, ChainRunStage, ChainSendConfirmation } from "./types";

/** 只在步骤边界停止；在途请求完成后保留其结果，绝不再启动后续步骤。 */
export async function runChain(
  chain: Chain,
  input: string,
  opts: Record<string, unknown> = {},
  onAiConfirm?: (step: ChainSendConfirmation, index: number) => Promise<boolean>,
  control: ChainRunControl = {},
): Promise<ChainRunResult> {
  const stages: ChainRunStage[] = [];
  let current = input;
  const stopped = (): ChainRunResult => ({ ok: false, cancelled: true, stages, final: current });
  const emit = (index: number, state: "running" | "confirming" | "finished") =>
    control.onProgress?.({ index, state, stages: [...stages] });
  const fail = (index: number, message: string, durationMs = 0): ChainRunResult => {
    const step = chain.steps[index];
    stages.push({ stepIndex: index, transformId: step?.transformId ?? "", label: step?.label ?? getTransform(step?.transformId ?? "")?.label ?? chain.name,
      risk: step?.risk ?? "local", input: current, output: "", ok: false, error: message, durationMs });
    emit(index, "finished");
    return { ok: false, stages, final: current, failedAt: index };
  };
  if (chain.steps.length === 0) return fail(0, chain.corrupted
    ? "这条链的步骤配置已损坏（后端无法解析），请重新配置后再跑"
    : "这条链没有任何步骤，无从执行");
  for (let i = 0; i < chain.steps.length; i++) {
    if (control.signal?.aborted) return stopped();
    const step = chain.steps[i];
    const t = getTransform(step.transformId);
    if (!t) return fail(i, "变换不存在（未注册），请重新选择这一步");
    if (t.kind === "action") return fail(i, "执行类动作有副作用，不能用于文本处理流程");
    const label = step.label ?? t.label;
    if (!matchesCondition(step.condition, current)) {
      stages.push({ stepIndex: i, transformId: t.id, label, risk: step.risk, input: current, output: current, ok: true, durationMs: 0, skipped: true });
      emit(i, "finished");
      continue;
    }
    if (t.remote) {
      if (!isAiAvailable()) return fail(i, "AI 功能未启用，请先配置后再运行");
      emit(i, "confirming");
      const confirmed = onAiConfirm ? await onAiConfirm({ transformId: t.id, label, input: current }, i) : false;
      if (control.signal?.aborted) return stopped();
      if (!confirmed) return { ...fail(i, "已取消：这一步会把内容发送到云端，需要你确认"), cancelled: true };
    }
    if (control.signal?.aborted) return stopped();
    emit(i, "running");
    const started = performance.now();
    try {
      const r = await t.run(current, opts);
      const durationMs = Math.round(performance.now() - started);
      if (!r.ok || r.output === undefined) return fail(i, r.message ?? "变换失败", durationMs);
      stages.push({ stepIndex: i, transformId: t.id, label, risk: t.remote ? "network" : step.risk, input: current, output: r.output, ok: true, durationMs });
      current = r.output;
      emit(i, "finished");
    } catch (error) {
      return fail(i, error instanceof Error ? error.message : String(error), Math.round(performance.now() - started));
    }
  }
  return control.signal?.aborted ? stopped() : { ok: true, stages, final: current };
}
