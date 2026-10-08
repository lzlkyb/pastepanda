import { useCallback, useEffect, useRef, useState } from "react";
import { knowledgeErrorText } from "@/lib/utils";
import {
  mobileKnowledgeEditGet, mobileKnowledgeEditBegin, mobileKnowledgeEditPut,
  mobileKnowledgeEditCommit, mobileKnowledgeEditCopy, mobileKnowledgeEditClear,
  type MobileKnowledgeEditDraft, type MobileKnowledgeEditResult,
} from "@/lib/api/mobileKnowledgeEdit";

/** Existing-note edits have their own durable slot; a capture can never replace them. */
export function useKnowledgeEdit(enabled: boolean) {
  const [draft, setDraft] = useState<MobileKnowledgeEditDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [locked, setLocked] = useState(false);
  const [conflict, setConflict] = useState<Exclude<MobileKnowledgeEditResult, { status: "saved" }> | null>(null);
  const value = useRef<MobileKnowledgeEditDraft | null>(null);
  const durable = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const writes = useRef(new Map<string, Promise<MobileKnowledgeEditDraft>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const loaded = useRef(false);
  const loading = useRef(false);
  const pending = useRef<{ id: string; revision: number; copy: boolean } | null>(null);
  const replace = useCallback((next: MobileKnowledgeEditDraft | null) => { value.current = next; setDraft(next); }, []);
  const write = useCallback((snapshot: MobileKnowledgeEditDraft) => {
    const key = `${snapshot.id}:${snapshot.revision}`;
    const existing = writes.current.get(key);
    if (existing) return existing;
    const operation = queue.current.catch(() => undefined).then(() => mobileKnowledgeEditPut(snapshot));
    queue.current = operation; writes.current.set(key, operation);
    void operation.then(() => writes.current.delete(key), () => writes.current.delete(key));
    void operation.then(() => {
      if (value.current?.id !== snapshot.id) return;
      durable.current = Math.max(durable.current, snapshot.revision);
      if (mounted.current && value.current.revision === snapshot.revision) { setStatus("修改草稿已保存到手机"); setError(""); }
    }, cause => {
      if (mounted.current && value.current?.id === snapshot.id) { setError(knowledgeErrorText(cause)); setStatus("输入仍保留，草稿尚未保存"); }
    });
    return operation;
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const snapshot = value.current;
    if (snapshot && !pending.current && durable.current < snapshot.revision) await write({ ...snapshot });
  }, [write]);
  const load = useCallback(async () => {
    if (loaded.current || loading.current) return;
    loading.current = true;
    try {
      const next = await mobileKnowledgeEditGet();
      if (!mounted.current) return;
      replace(next); durable.current = next?.revision ?? 0;
      loaded.current = true; setReady(true); setError(""); setStatus(next ? "上次修改草稿已恢复" : "");
    } catch (cause) { if (mounted.current) { setError(knowledgeErrorText(cause)); setReady(false); } }
    finally { loading.current = false; }
  }, [replace]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void flush().catch(() => undefined); }; }, [flush]);
  useEffect(() => { if (enabled) void load(); else void flush().catch(() => undefined); }, [enabled, load, flush]);
  useEffect(() => {
    const hide = () => { void flush().catch(() => undefined); };
    const visibility = () => { if (document.hidden) hide(); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", hide);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", hide); };
  }, [flush]);
  const begin = useCallback(async (noteId: string) => {
    if (!ready || busy.current) return false;
    if (value.current) {
      if (value.current.note_id === noteId) return true;
      setError("先继续或放弃已有修改草稿，再编辑另一篇笔记。"); return false;
    }
    busy.current = true; setSaving(true); setError("");
    try {
      const next = await mobileKnowledgeEditBegin(noteId);
      replace(next); durable.current = next.revision; setConflict(null); setStatus("修改草稿已保存到手机"); return true;
    } catch (cause) { setError(knowledgeErrorText(cause)); return false; }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [ready, replace]);
  const update = useCallback(<K extends "title" | "content" | "folder_id" | "tag_ids">(field: K, text: MobileKnowledgeEditDraft[K]) => {
    if (!value.current || busy.current || pending.current) return;
    const next = { ...value.current, [field]: text, revision: value.current.revision + 1 };
    replace(next); setStatus("正在保存修改草稿…");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void write(next).catch(() => undefined); }, 300);
  }, [replace, write]);
  const discard = useCallback(async () => {
    if (!value.current || busy.current || pending.current) return false;
    busy.current = true; setSaving(true);
    try {
      await flush(); const latest = value.current!;
      await mobileKnowledgeEditClear(latest.id, latest.revision);
      replace(null); durable.current = 0; setConflict(null); setError(""); setStatus(""); return true;
    } catch (cause) { setError(knowledgeErrorText(cause)); return false; }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [flush, replace]);
  const save = useCallback(async (copy = false) => {
    if (!value.current || busy.current) return null;
    if (!value.current.title.trim()) { setError("请填写标题，再保存修改。"); return null; }
    busy.current = true; setSaving(true); setError("");
    try {
      if (!pending.current) { await flush(); pending.current = { id: value.current.id, revision: value.current.revision, copy }; }
      // A lost reply must retry the same operation; never turn a pending update into a copy.
      setLocked(true);
      const action = pending.current;
      const result = await (action.copy ? mobileKnowledgeEditCopy : mobileKnowledgeEditCommit)(action.id, action.revision);
      pending.current = null; setLocked(false);
      if (result.status !== "saved") { setConflict(result); setStatus("手机修改已保留，请选择如何处理"); return null; }
      replace(null); durable.current = 0; setConflict(null); setStatus(""); return { ...result, copied: action.copy };
    } catch (cause) {
      const rejected = cause instanceof Error ? cause.message : String(cause);
      if (/^MOBILE_EDIT_REJECTED:(?:folder_missing|tag_missing|title_empty)/.test(rejected)) {
        pending.current = null; setLocked(false);
      }
      setError(pending.current ? "保存结果未能确认，修改已保留。请重试同一次保存后继续编辑。" : knowledgeErrorText(cause));
      return null;
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [flush, replace]);
  return { draft, ready, saving, error, status, locked, conflict, begin, update, flush, discard, save, retryLoad: load };
}
