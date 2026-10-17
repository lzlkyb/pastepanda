import { useCallback, useEffect, useRef, useState } from "react";
import { runChain } from "@/lib/chains/registry";
import type { Chain, ChainRunProgress, ChainRunResult, ChainSendConfirmation } from "@/lib/chains/types";

export function useChainRun(chain: Chain | null, input: string) {
  const [result, setResult] = useState<ChainRunResult | null>(null);
  const [progress, setProgress] = useState<ChainRunProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<(ChainSendConfirmation & { index: number; respond: (yes: boolean) => void }) | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const stages = useRef<ChainRunProgress["stages"]>([]);
  const reset = useCallback(() => {
    epoch.current++;
    controller.current?.abort();
    controller.current = null;
    stages.current = [];
    setResult(null); setProgress(null); setRunning(false); setStopping(false); setPending(null); setError("");
  }, []);
  useEffect(() => { reset(); return reset; }, [chain, input, reset]);
  const run = useCallback(async () => {
    if (!chain || running || !input.trim()) return;
    const id = ++epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    stages.current = [];
    setRunning(true); setStopping(false); setResult(null); setError(""); setProgress(null);
    try {
      const completed = await runChain(chain, input, {}, (step, index) => new Promise<boolean>(resolve => {
        // 取消确认必须释放等待中的 Promise，避免停止后仍挂起整条执行链。
        const respond = (yes: boolean) => {
          abort.signal.removeEventListener("abort", cancel);
          if (epoch.current === id) setPending(null);
          resolve(yes);
        };
        const cancel = () => respond(false);
        if (abort.signal.aborted || epoch.current !== id) { resolve(false); return; }
        abort.signal.addEventListener("abort", cancel, { once: true });
        setPending({ ...step, index, respond });
      }), { signal: abort.signal, onProgress: p => {
        if (epoch.current !== id) return;
        stages.current = p.stages;
        setProgress(p);
      } });
      if (epoch.current === id) setResult(completed);
    } catch (e) {
      if (epoch.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch.current === id) { setRunning(false); setStopping(false); setPending(null); }
    }
  }, [chain, input, running]);
  const stop = useCallback(() => {
    controller.current?.abort();
    setStopping(true);
    const completed = stages.current.filter(s => s.ok);
    setResult({ ok: false, cancelled: true, stages: stages.current,
      final: completed[completed.length - 1]?.output ?? input });
  }, [input]);
  return { result, progress, running, stopping, error, pending, run, stop, reset };
}
