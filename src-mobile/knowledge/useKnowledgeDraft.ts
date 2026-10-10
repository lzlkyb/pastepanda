import { useCallback, useEffect, useRef, useState } from "react";
import { mobileKnowledgeDraftGet, mobileKnowledgeDraftPut, mobileKnowledgeDraftClear, mobileKnowledgeDraftCommit, type MobileKnowledgeDraft } from "@/lib/api/mobileKnowledge";
import { knowledgeErrorText } from "@/lib/utils";

export function useKnowledgeDraft(enabled: boolean) {
  const [draft, setDraft] = useState<MobileKnowledgeDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [locked, setLocked] = useState(false);
  const value = useRef<MobileKnowledgeDraft | null>(null);
  const durable = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const writes = useRef(new Map<string, Promise<MobileKnowledgeDraft>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const pending = useRef<{ id: string; revision: number } | null>(null);
  const loaded = useRef(false);
  const loading = useRef(false);
  const replace = useCallback((next: MobileKnowledgeDraft | null) => { value.current = next; setDraft(next); }, []);
  const write = useCallback((snapshot: MobileKnowledgeDraft) => {
    const key = `${snapshot.id}:${snapshot.revision}`;
    const existing = writes.current.get(key);
    if (existing) return existing;
    // Serialize autosave and commit: an older IPC completion cannot restore a cleared draft.
    const operation = queue.current.catch(() => undefined).then(() => mobileKnowledgeDraftPut(snapshot));
    queue.current = operation;
    writes.current.set(key, operation);
    void operation.then(() => writes.current.delete(key), () => writes.current.delete(key));
    void operation.then(() => {
      if (value.current?.id !== snapshot.id) return;
      durable.current = Math.max(durable.current, snapshot.revision);
      if (mounted.current && value.current.revision === snapshot.revision) { setStatus("草稿已保存到手机"); setError(""); }
    }).catch(cause => {
      if (mounted.current && value.current?.id === snapshot.id) { setError(knowledgeErrorText(cause)); setStatus("输入仍在，草稿尚未保存"); }
    });
    return operation;
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const snapshot = value.current;
    if (!snapshot || pending.current) return;
    if (durable.current < snapshot.revision) await write({ ...snapshot });
    // A confirmed durable version is sufficient. A redundant later IPC failure
    // must not poison save retries for content already known to be on disk.
  }, [write]);
  const load = useCallback(async () => {
    if (loaded.current || loading.current) return;
    loading.current = true;
    setError("");
    try {
      const restored = await mobileKnowledgeDraftGet();
      if (!mounted.current) return;
      replace(restored); durable.current = restored?.revision ?? 0;
      loaded.current = true; setReady(true); setStatus(restored ? "上次草稿已恢复" : "");
    } catch (cause) { if (mounted.current) { setError(knowledgeErrorText(cause)); setReady(false); } }
    finally { loading.current = false; }
  }, [replace]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void flush().catch(() => undefined); }; }, [flush]);
  useEffect(() => { if (enabled) void load(); else void flush().catch(() => undefined); }, [enabled, load, flush]);
  useEffect(() => {
    const preserve = () => { if (document.hidden) void flush().catch(() => undefined); };
    const hide = () => { void flush().catch(() => undefined); };
    document.addEventListener("visibilitychange", preserve); window.addEventListener("pagehide", hide);
    return () => { document.removeEventListener("visibilitychange", preserve); window.removeEventListener("pagehide", hide); };
  }, [flush]);
  const begin = useCallback(async (initial?: { id: string; title: string; content: string }) => {
    if (!ready || busy.current) return false;
    if (value.current) {
      if (!initial || initial.id === value.current.id) return true;
      setError("已有未完成记录。分享内容仍保留，请先继续或放弃原草稿。"); return false;
    }
    const next = { id: initial?.id || crypto.randomUUID(), revision: 1, title: initial?.title || "", content: initial?.content || "", folder_id: null, tag_ids: [] };
    durable.current = 0; replace(next); setError(""); setStatus("正在保存草稿…");
    try { await write(next); } catch { /* Keep the input surface available for recovery. */ }
    return true;
  }, [ready, replace, write]);
  const update = useCallback(<K extends "title" | "content" | "folder_id" | "tag_ids">(field: K, text: MobileKnowledgeDraft[K]) => {
    if (!value.current || busy.current || pending.current) return;
    const next = { ...value.current, [field]: text, revision: value.current.revision + 1 };
    replace(next); setStatus("正在保存草稿…");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void write({ ...next }).catch(() => undefined); }, 300);
  }, [replace, write]);
  const discard = useCallback(async () => {
    if (!value.current || busy.current || pending.current) return false;
    busy.current = true; setSaving(true);
    try {
      await flush(); const latest = value.current!;
      await mobileKnowledgeDraftClear(latest.id, latest.revision);
      replace(null); durable.current = 0; setError(""); setStatus(""); return true;
    } catch (cause) { setError(knowledgeErrorText(cause)); return false; }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [flush, replace]);
  const save = useCallback(async (expectedId?: string) => {
    if (!value.current || busy.current) return null;
    if (expectedId && value.current.id !== expectedId) {
      setError("原收集草稿已变化，当前草稿没有被保存。请先核对原笔记。"); return null;
    }
    if (!value.current.content.trim()) { setError("先记一点内容，再保存到手机。"); return null; }
    busy.current = true; setSaving(true); setError("");
    try {
      if (!pending.current) { await flush(); pending.current = { id: value.current.id, revision: value.current.revision }; }
      setLocked(true);
      const note = await mobileKnowledgeDraftCommit(pending.current.id, pending.current.revision);
      pending.current = null; replace(null); durable.current = 0; setLocked(false); setStatus(""); return note;
    } catch (cause) {
      const rejected = cause instanceof Error ? cause.message : String(cause);
      // A transactional validation rejection is a known no-write result: allow fixing classification.
      if (/^MOBILE_EDIT_REJECTED:(?:folder_missing|tag_missing)/.test(rejected)) {
        pending.current = null; setLocked(false);
      }
      setError(pending.current ? "保存结果未能确认，输入已保留。请重试核对后继续编辑。" : knowledgeErrorText(cause));
      return null;
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [flush, replace]);
  return { draft, ready, saving, error, status, locked, begin, update, flush, discard, save, retryLoad: load };
}
