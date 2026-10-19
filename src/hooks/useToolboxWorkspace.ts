import { useEffect, useRef, useState } from "react";
import type { ToolHandlers, ToolItem, ToolKey } from "@/lib/toolbox";
import { bumpUsage, loadRecent, loadToolboxPins, loadUsage, pushRecent, saveRecent, saveToolboxPins, saveUsage, TOOLBOX_PIN_LIMIT } from "@/lib/toolboxUsage";
import { blocksPageShortcuts, isConfirmLayerPresent } from "@/lib/modalLayers";

export function useToolboxWorkspace(handlers: ToolHandlers) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [pins, setPins] = useState(loadToolboxPins);
  const [recent, setRecent] = useState(loadRecent);
  const [draft, setDraft] = useState<ToolKey[] | null>(null);
  const [pad, setPad] = useState<"mine" | "recent">("mine");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const cancel = () => { setDraft(null); setError(""); editRef.current?.focus(); };
  const editing = draft !== null;
  const wasEditing = useRef(false);
  useEffect(() => {
    // A nonempty search hides the launchpad after editing, including its edit trigger.
    if (wasEditing.current && !editing) (editRef.current ?? searchRef.current)?.focus();
    wasEditing.current = editing;
  }, [editing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || blocksPageShortcuts() || isConfirmLayerPresent()) return;
      if (editing && event.key === "Escape") {
        if (event.target === searchRef.current && searchRef.current?.value) return;
        event.preventDefault(); event.stopImmediatePropagation();
        setDraft(null); setError(""); editRef.current?.focus(); return;
      }
      const target = event.target as HTMLElement | null;
      const inField = target instanceof HTMLElement && (target.matches("input,textarea,select") || target.isContentEditable);
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") || (event.key === "/" && !inField && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault(); event.stopPropagation(); searchRef.current?.focus(); searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);

  const run = (tool: ToolItem) => {
    const handler = handlers[tool.key];
    if (!handler || editing) return;
    const next = pushRecent(recent, tool.key);
    setRecent(next); saveRecent(next);
    saveUsage(bumpUsage(loadUsage(), tool.key));
    handler();
  };
  const togglePin = (key: ToolKey) => {
    if (!draft) return;
    if (draft.includes(key)) { setDraft(draft.filter(item => item !== key)); setError(""); }
    else if (draft.length < TOOLBOX_PIN_LIMIT) { setDraft([...draft, key]); setError(""); }
    else setError("最多固定 6 个工具，请先移除一项再添加。");
  };
  const move = (index: number, direction: number) => {
    if (!draft || index + direction < 0 || index + direction >= draft.length) return;
    const next = [...draft];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setDraft(next);
  };
  const save = () => {
    if (!draft) return;
    if (!saveToolboxPins(draft)) { setError("常用工具未保存，请确认本地存储可用后重试。"); return; }
    setPins(draft); setDraft(null); setError(""); setNotice("常用工具已保存"); editRef.current?.focus();
  };
  const begin = () => { setDraft([...pins]); setPad("mine"); setQuery(""); setError(""); setNotice(""); };
  return { query, setQuery, category, setCategory, pins, recent, draft, pad, setPad, error, notice, setNotice, searchRef, editRef, editing, cancel, begin, save, togglePin, move, run };
}
