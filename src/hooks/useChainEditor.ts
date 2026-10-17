import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { getAiAvailability, subscribeAiAvailability } from "@/lib/aiAvailability";
import { useDialogStore } from "@/stores/dialogStore";
import { chainSave, chainDelete, type ChainDef } from "@/lib/api/chains";
import { chainStepTransforms, invalidateUserChains, riskOf } from "@/lib/chains/registry";
import type { ChainStepConditionType } from "@/lib/chains/types";
import { confirmDialog } from "@/lib/confirm";
import { useToast } from "@/components/Toast";

export const MAX_CHAIN_NAME_CHARS = 24;
export const MAX_CHAIN_STEPS = 8;

export function useChainEditor() {
  const aiStatus = useSyncExternalStore(subscribeAiAvailability, getAiAvailability, getAiAvailability);
  const editing = useDialogStore(s => s.chainEdit);
  const session = useDialogStore(s => s.chainSession);
  const open = editing !== null;
  const [draft, setDraftState] = useState<ChainDef>({ id: "", name: "", description: "", steps: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();
  const key = `${session}:${editing?.id || JSON.stringify(editing)}`;
  const retained = useRef<{ key: string; draft: ChainDef } | null>(null);
  useEffect(() => {
    if (!editing) return;
    setDraftState(retained.current?.key === key ? retained.current.draft : { ...editing, steps: editing.steps.map(s => ({ ...s })) });
    setError("");
  }, [editing, key]);
  const update = (change: SetStateAction<ChainDef>) => {
    setDraftState(old => {
      const next = typeof change === "function" ? change(old) : change;
      // 只保留本次编辑的一份草稿；返回不会卸掉缓存，也不积累跨会话草稿。
      retained.current = { key, draft: next };
      return next;
    });
    setError("");
  };
  const close = useCallback(() => { if (!saving) useDialogStore.getState().closeChainEditor(); }, [saving]);
  // 注册表会在配置 AI 后变化，重新打开编辑器时必须取新快照。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => chainStepTransforms(), [open, aiStatus.status]);
  const patch = (p: Partial<ChainDef>) => update(d => ({ ...d, ...p }));
  const setStep = (index: number, id: string) => update(d => ({ ...d, steps: d.steps.map((s, i) => i === index
    ? { ...s, transformId: id, label: undefined, risk: riskOf(options.find(t => t.id === id)) } : s) }));
  const setCondition = (index: number, condition: ChainStepConditionType) => update(d => ({ ...d, steps: d.steps.map((s, i) => i === index
    ? { ...s, condition: condition === "always" ? undefined : { type: condition } } : s) }));
  const add = () => { if (draft.steps.length < MAX_CHAIN_STEPS) update(d => ({ ...d, steps: [...d.steps, { transformId: "", risk: "local" }] })); };
  const move = (index: number, delta: number) => update(d => {
    const next = index + delta;
    if (next < 0 || next >= d.steps.length) return d;
    const steps = [...d.steps]; [steps[index], steps[next]] = [steps[next], steps[index]];
    return { ...d, steps };
  });
  const removeStep = (index: number) => update(d => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
  const save = async () => {
    if (saving) return;
    if (!draft.name.trim()) { setError("请给这个流程起个名字。"); return; }
    if (!draft.steps.length) { setError("至少添加一个处理步骤。"); return; }
    const available = new Set(chainStepTransforms().map(t => t.id));
    const bad = draft.steps.findIndex(s => !available.has(s.transformId));
    if (bad >= 0) { setError(`第 ${bad + 1} 步尚未选择或已不可用，请重新选择。`); return; }
    setSaving(true); setError("");
    try {
      const saved = { ...draft, name: draft.name.trim() };
      const id = await chainSave(saved);
      invalidateUserChains(); retained.current = null;
      if (useDialogStore.getState().chainEdit === editing) useDialogStore.getState().finishChainEdit({ saved: { ...saved, id } });
      toast(`已保存「${saved.name}」`, "success");
    } catch (e) { setError(`保存失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft.id || saving) return;
    const yes = await confirmDialog({ title: "删除流程", message: `删除「${draft.name}」？此操作不可恢复。`, confirmText: "删除", variant: "danger" });
    if (!yes) return;
    setSaving(true); setError("");
    try {
      await chainDelete(draft.id); invalidateUserChains(); retained.current = null;
      if (useDialogStore.getState().chainEdit === editing) useDialogStore.getState().finishChainEdit({ deletedId: draft.id });
      toast("流程已删除", "success");
    } catch (e) { setError(`删除失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  const discard = () => { if (!saving) { retained.current = null; close(); } };
  return { open, draft, options, saving, error, close, discard, patch, setStep, setCondition, add, move, removeStep, save, remove };
}
