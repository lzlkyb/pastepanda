import { useEffect, useRef, useState } from "react";
import { htmlToMarkdown } from "@/lib/notes/htmlToMd";
import { knowledgeArticleErrorText } from "@/lib/utils";
import { mobileArticleAckSources, mobileArticleBegin, mobileArticleFetch, mobileArticleGet, mobileArticlePending, mobileArticlePut, mobileArticleSave, type MobileArticle, type MobileArticleFields } from "@/lib/api/mobileArticle";
import type { MobileKnowledgeIncoming } from "@/lib/api/mobileKnowledgeShare";
import type { useKnowledgeInbox } from "./useKnowledgeInbox";

export function useKnowledgeArticle(active: boolean, inbox: ReturnType<typeof useKnowledgeInbox> | undefined, onSaved: (id: string, title: string) => void) {
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<MobileArticle | null>(null);
  const [pending, setPending] = useState<MobileArticle[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<MobileArticle | null>(null);
  const generation = useRef(0);
  const dirty = useRef(false);
  const writes = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const epoch = useRef(0);
  const visible = useRef(false);
  const locked = useRef(false);
  const committing = useRef(false);
  const incoming = useRef<string | null>(null);
  const accept = (value: MobileArticle | null) => { current.current = value; setTask(value); };
  const refresh = async () => {
    try { setPending(await mobileArticlePending()); }
    catch { setError("待收集文章暂时无法读取，请重试。"); }
  };
  useEffect(() => { if (active) void refresh(); }, [active]);
  useEffect(() => () => { visible.current = false; ++epoch.current; clearTimeout(timer.current); }, []);
  const flush = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    try {
      if (writes.current) await writes.current;
      while (dirty.current && current.current) {
        const snapshot = current.current, changed = generation.current;
        writes.current = mobileArticlePut(snapshot.id, snapshot).then(value => {
          if (current.current?.id !== snapshot.id) return;
          if (generation.current === changed) { dirty.current = false; accept(value); }
          else accept({ ...value, title: current.current.title, body: current.current.body, remarks: current.current.remarks, folder_id: current.current.folder_id, tag_ids: current.current.tag_ids });
        });
        await writes.current; writes.current = null;
      }
      return true;
    } catch (cause) { writes.current = null; setError(`修改还没有保存：${knowledgeArticleErrorText(cause)}`); return false; }
  };
  const change = <K extends keyof MobileArticleFields>(key: K, value: MobileArticleFields[K]) => {
    if (!current.current || locked.current) return;
    accept({ ...current.current, [key]: value }); ++generation.current; dirty.current = true;
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, 500);
  };
  const convert = async (value: MobileArticle): Promise<MobileArticle> => {
    if (!value.html) return value;
    const converted = htmlToMarkdown(value.html);
    if (!converted?.trim()) { setError("这篇网页没有可读正文，链接仍保留。可以仅存链接或重新读取。"); return value; }
    // The reader owns the title; only remove the matching leading article heading.
    const heading = `# ${value.title.trim()}\n`;
    const body = converted.startsWith(heading) ? converted.slice(heading.length).trimStart() : converted;
    return mobileArticlePut(value.id, { ...value, body });
  };
  const fetch = async () => {
    if (!current.current || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const id = current.current.id, token = epoch.current;
    try {
      if (!await flush()) return;
      const result = await convert(await mobileArticleFetch(id));
      if (epoch.current === token && current.current?.id === id) { accept(result); if (result.error) setError(knowledgeArticleErrorText(result.error)); }
    } catch (cause) { if (epoch.current === token) setError(knowledgeArticleErrorText(cause)); }
    finally { if (epoch.current === token) { locked.current = false; setBusy(false); } void refresh(); }
  };
  const begin = async (url?: string, item?: MobileKnowledgeIncoming, id?: string) => {
    if (locked.current || !await flush()) return;
    const token = ++epoch.current; visible.current = true; setOpen(true); setError(""); incoming.current = item?.id || null;
    if (!url && !id) { accept(null); return; }
    locked.current = true; setBusy(true);
    try {
      let value = await convert(id ? await mobileArticleGet(id) : await mobileArticleBegin(url!, item?.id));
      if (item && !value.note_id && !value.duplicate_note_id && !value.remarks && !value.body) {
        const context = item.text.replace(/https?:\/\/[^\s<>]+/gi, "").trim();
        if (context) value = await mobileArticlePut(value.id, { ...value, remarks: context });
      }
      if (epoch.current !== token || !visible.current) return;
      accept(value);
      if (!value.note_id && !value.duplicate_note_id && !value.body && !value.error) {
        locked.current = false; await fetch();
      }
    } catch (cause) { if (epoch.current === token) setError(knowledgeArticleErrorText(cause)); }
    finally { if (epoch.current === token) { locked.current = false; setBusy(false); } void refresh(); }
  };
  const close = async () => {
    if (committing.current) return;
    if (dirty.current && !await flush()) return;
    visible.current = false; ++epoch.current; locked.current = false; setBusy(false); setOpen(false); void refresh();
  };
  const finish = async (id: string, message: string) => {
    const sources = [...new Set([...(current.current?.source_ids || []), ...(incoming.current ? [incoming.current] : [])])].filter(id => inbox?.items.some(item=>item.id===id));
    for (const source of sources) if (inbox && !await inbox.acknowledge(source)) {
      setError("文章已保存到手机，分享收集状态还未清理。重试不会重复保存。");
      const value = current.current && await mobileArticleGet(current.current.id); if (value) accept(value);
      return;
    }
    if (current.current?.source_ids.length) accept(await mobileArticleAckSources(current.current.id, current.current.source_ids));
    incoming.current = null; visible.current = false; ++epoch.current; setOpen(false); void refresh(); onSaved(id, message);
  };
  const save = async (linkOnly: boolean) => {
    if (!current.current || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    committing.current = true; setSaving(true);
    try {
      if (!await flush() || !current.current) return;
      const value = current.current;
      const note = await mobileArticleSave(value.id, value.revision, linkOnly);
      accept(await mobileArticleGet(value.id));
      await finish(note.id, linkOnly ? "链接已保存到手机，正文尚未保存" : value.note_id ? "正文已补充到原笔记" : "文章已保存到手机");
    } catch (cause) {
      setError(knowledgeArticleErrorText(cause));
      // Saving may discover that another pending redirect has already committed.
      // Re-read its durable duplicate receipt so the existing-note action is visible.
      if (current.current) { try { accept(await mobileArticleGet(current.current.id)); } catch { /* Keep the preview if the receipt cannot yet be read. */ } }
    }
    finally { committing.current = false; setSaving(false); locked.current = false; setBusy(false); }
  };
  const existing = async () => {
    const id = current.current?.duplicate_note_id || current.current?.note_id;
    if (!id || locked.current) return;
    locked.current = true; setBusy(true);
    committing.current = true; setSaving(true);
    try { await finish(id, "已打开已有收藏"); }
    catch (cause) { setError(knowledgeArticleErrorText(cause)); }
    finally { committing.current = false; setSaving(false); locked.current = false; setBusy(false); }
  };
  return { open, task, pending, busy, saving, error, change, begin, close, fetch, save, existing, refresh };
}
