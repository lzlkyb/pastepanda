import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDialogStore } from "@/stores/dialogStore";
import { isChainAvailable, loadUserChains, PRESET_CHAINS } from "@/lib/chains/registry";
import { getAiAvailability, subscribeAiAvailability } from "@/lib/aiAvailability";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import type { Chain } from "@/lib/chains/types";
import { useChainRun } from "./useChainRun";
import { useChainPlanner } from "./useChainPlanner";

export function useChainWorkspace() {
  const aiStatus = useSyncExternalStore(subscribeAiAvailability, getAiAvailability, getAiAvailability);
  const aiAvailable = aiStatus.status === "on";
  const text = useDialogStore(s => s.chainText);
  const session = useDialogStore(s => s.chainSession);
  const editing = useDialogStore(s => s.chainEdit !== null);
  const change = useDialogStore(s => s.chainChange);
  const open = text !== null;
  const [input, setInput] = useState("");
  const [view, setView] = useState<"choose" | "review" | "ai">("choose");
  const [chains, setChains] = useState<Chain[]>(PRESET_CHAINS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const listEpoch = useRef(0);
  const selected = chains.find(c => c.id === selectedId && isChainAvailable(c)) ?? null;
  const run = useChainRun(selected, input);
  const acceptPlan = useCallback((chain: Chain, notes: string[]) => {
    listEpoch.current++; setLoading(false);
    setChains(all => [chain, ...all.filter(c => c.id !== chain.id)]);
    setWarnings(notes); setSelectedId(chain.id); setView("review");
  }, []);
  const planner = useChainPlanner(input, acceptPlan);
  useEffect(() => {
    if (!open) { listEpoch.current++; run.reset(); planner.reset(); return; }
    const state = useDialogStore.getState();
    setInput(text ?? ""); setQuery(""); setWarnings([]); setLoadError("");
    setSelectedId(state.chainAdHoc?.id ?? state.chainIdHint);
    setView(state.chainMode === "ai" && isAiAvailable() ? "ai" : state.chainAdHoc || state.chainIdHint ? "review" : "choose");
    setChains([...(state.chainAdHoc ? [state.chainAdHoc] : []), ...PRESET_CHAINS]);
    run.reset(); planner.reset();
    let cancelled = false;
    const loadId = ++listEpoch.current;
    setLoading(true);
    loadUserChains(true, true).then(user => {
      if (!cancelled && listEpoch.current === loadId) setChains([...(state.chainAdHoc ? [state.chainAdHoc] : []), ...user, ...PRESET_CHAINS]);
    }).catch(() => { if (!cancelled && listEpoch.current === loadId) setLoadError("暂时无法读取你保存的流程。数据没有被删除，仍可使用内置流程。"); })
      .finally(() => { if (!cancelled && listEpoch.current === loadId) setLoading(false); });
    return () => { cancelled = true; };
    // 会话 id 区分相同文字的再次打开；普通 rerender 不能清空输入和草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session]);
  useEffect(() => {
    if (!open || !change) return;
    // 保存比此前的读取更新，迟到的旧列表不能把刚保存的流程抹掉。
    listEpoch.current++; setLoading(false); setLoadError("");
    if ("saved" in change) {
      setChains(all => [change.saved, ...all.filter(c => c.id !== change.saved.id)]);
      setSelectedId(change.saved.id); setView("review"); setWarnings([]);
    } else {
      setChains(all => all.filter(c => c.id !== change.deletedId));
      setSelectedId(null); setView("choose");
    }
  }, [open, change]);
  const reload = useCallback(async () => {
    setLoading(true); setLoadError("");
    const id = useDialogStore.getState().chainSession;
    const loadId = ++listEpoch.current;
    try {
      const user = await loadUserChains(true, true);
      if (listEpoch.current === loadId && useDialogStore.getState().chainSession === id && useDialogStore.getState().chainText !== null)
        setChains(all => [...all.filter(c => c.id === "ai-planned"), ...user, ...PRESET_CHAINS]);
    } catch { if (listEpoch.current === loadId && useDialogStore.getState().chainSession === id) setLoadError("读取失败，请重试。内置流程仍可使用。"); }
    finally { if (listEpoch.current === loadId && useDialogStore.getState().chainSession === id) setLoading(false); }
  }, []);
  const select = (chain: Chain) => {
    if (run.running || planner.loading || !isChainAvailable(chain)) return;
    setSelectedId(chain.id); setView("review"); setWarnings([]);
  };
  const switchView = (next: "choose" | "ai") => {
    if (run.running || planner.loading || (next === "ai" && !isAiAvailable())) return;
    run.reset(); setView(next);
  };
  const back = () => {
    if (planner.loading) { planner.stop(); return; }
    if (run.running && !run.stopping) { run.stop(); return; }
    if (run.result) { run.reset(); setView("review"); return; }
    if (view === "review" || (view === "ai" && !useDialogStore.getState().hubItem)) { setView("choose"); return; }
    useDialogStore.getState().closeChain();
  };
  const close = () => {
    if (run.running && !run.stopping) { run.stop(); return; }
    planner.stop(); run.reset(); useDialogStore.getState().closeChain();
  };
  const edit = (fresh = false) => {
    if (run.running || planner.loading) return;
    if (fresh || !selected) useDialogStore.getState().openChainEditor(null);
    else useDialogStore.getState().openChainEditor({
      id: PRESET_CHAINS.some(c => c.id === selected.id) || selected.id === "ai-planned" ? "" : selected.id,
      name: selected.name, description: selected.description, steps: selected.steps,
    });
  };
  const available = chains.filter(isChainAvailable);
  return { open, editing, aiAvailable, input, setInput, view: !aiAvailable && view === "ai" ? "choose" as const : view, switchView, selected, select, chains: available,
    query, setQuery, loading, loadError, reload, warnings, run, planner, back, close, edit };
}
