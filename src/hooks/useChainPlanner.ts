import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestPlannedChain } from "@/lib/chains/planRequest";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { getSession, mergeSessionTexts } from "@/lib/sessionContext";
import type { Chain } from "@/lib/chains/types";

export function useChainPlanner(input: string, onPlan: (chain: Chain, warnings: string[]) => void) {
  const [goal, setGoalState] = useState("");
  const [includeSession, setIncludeSession] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState("");
  const epoch = useRef(0);
  const session = getSession();
  const sessionText = useMemo(() => session && session.texts.length > 1 ? mergeSessionTexts(session) : "", [session]);
  const planText = includeSession && sessionText ? `${input}\n\n连续复制的上下文：\n${sessionText}` : input;
  const sample = Array.from(planText.slice(0, 3000)).slice(0, 1500).join("");
  const stop = useCallback(() => { epoch.current++; setLoading(false); setNeedsConfirm(""); setNotice("已停止等待。已发出的请求无法撤回，仍可能产生用量。"); }, []);
  const reset = useCallback(() => { stop(); setGoalState(""); setIncludeSession(false); setError(""); setNotice(""); }, [stop]);
  useEffect(() => { setNeedsConfirm(""); }, [goal, planText]);
  useEffect(() => () => { epoch.current++; }, []);
  const setGoal = (value: string) => { setGoalState(value); setError(""); setNeedsConfirm(""); };
  const generate = useCallback(async (force = false) => {
    if (loading || !goal.trim() || !input.trim() || !isAiAvailable()) return;
    const id = ++epoch.current;
    setLoading(true); setError(""); setNeedsConfirm(""); setNotice("");
    try {
      const outcome = await requestPlannedChain(planText, force, goal.trim());
      if (epoch.current !== id || !isAiAvailable()) return;
      if (outcome.status === "needsConfirm") { setNeedsConfirm(outcome.reason); return; }
      if (outcome.status === "budgetExceeded") {
        setError(`今日 AI 预算已用完（¥${outcome.spentCny.toFixed(2)} / ¥${outcome.budgetCny.toFixed(2)}），可稍后重试或在 AI 设置调整预算。`); return;
      }
      if (outcome.status === "unusable") { setError("没有生成可用步骤。请把目标说得更具体，或使用现成流程。"); return; }
      const warnings = [
        ...(outcome.dropped.length ? [`已移除 ${outcome.dropped.length} 个不可用步骤，请核对剩余流程是否仍符合目标。`] : []),
        ...(outcome.truncated ? ["AI 输出被截断，这份流程可能不完整，请调整后再运行。"] : []),
      ];
      onPlan(outcome.chain, warnings);
    } catch (e) { if (epoch.current === id) setError(`没有生成流程：${e instanceof Error ? e.message : String(e)}`); }
    finally { if (epoch.current === id) setLoading(false); }
  }, [goal, input, planText, loading, onPlan]);
  return { goal, setGoal, includeSession, setIncludeSession, sessionText, sample, loading, error, notice, needsConfirm, generate, stop, reset };
}
