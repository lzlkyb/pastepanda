import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "@/lib/api/notes";
import { knowledgeErrorText } from "@/lib/utils";
import { mobileKnowledgeGet, mobileKnowledgeMeta, mobileKnowledgeVisit, type MobileNoteMeta } from "@/lib/api/mobileKnowledge";

export function useKnowledgeReading(noteId: string, active: boolean) {
  const [note, setNote] = useState<Note | null>(null);
  const [meta, setMeta] = useState<MobileNoteMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorDetail, setErrorDetail] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [metaError, setMetaError] = useState(false);
  const [newer, setNewer] = useState(false);
  const [missing, setMissing] = useState(false);
  const [positionError, setPositionError] = useState(false);
  const current = useRef<Note | null>(null);
  const generation = useRef(0);
  const position = useRef({ id: noteId, ratio: 0, ready: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const savePosition = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const saved = { ...position.current };
    if (!saved.ready) return;
    void mobileKnowledgeVisit(saved.id, saved.ratio).then(() => {
      if (position.current.id === saved.id) setPositionError(false);
    }, () => {
      if (position.current.id === saved.id) setPositionError(true);
    });
  }, []);

  const load = useCallback(async (replace = false) => {
    const token = ++generation.current;
    const first = current.current?.id !== noteId;
    setLoading(true);
    setError(false);
    const [content, metadata] = await Promise.allSettled([mobileKnowledgeGet(noteId), mobileKnowledgeMeta(noteId)]);
    if (token !== generation.current) return;
    setLoading(false);
    if (content.status === "rejected") { setError(true); setErrorDetail(knowledgeErrorText(content.reason)); return; }
    const next = content.value;
    if (!next || next.deleted_at) { setMissing(true); return; }
    setMissing(false);
    if (metadata.status === "fulfilled") {
      setMeta(metadata.value); setMetaError(false);
      if (first || !position.current.ready) position.current = { id: noteId, ratio: metadata.value.reading_position, ready: true };
    } else { setMetaError(true); if (first) position.current = { id: noteId, ratio: 0, ready: false }; }
    // Reading must remain stable when a sync replaces the underlying local note.
    if (!first && !replace && (next.updated_at !== current.current?.updated_at || next.content !== current.current?.content)) {
      setNewer(true); return;
    }
    current.current = next; setNote(next); setNewer(false);
    if (first && metadata.status === "fulfilled") savePosition();
  }, [noteId, savePosition]);

  useEffect(() => {
    current.current = null; setNote(null); setMeta(null); setMissing(false); setNewer(false); setPositionError(false);
    position.current = { id: noteId, ratio: 0, ready: false };
  }, [noteId]);
  useEffect(() => {
    if (!active) return;
    void load();
    const resume = () => { if (!document.hidden) void load(); };
    const visibility = () => { if (document.hidden) savePosition(); else resume(); };
    window.addEventListener("focus", resume);
    const network = () => setOnline(navigator.onLine);
    window.addEventListener("online", network); window.addEventListener("offline", network);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      ++generation.current; savePosition();
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", network); window.removeEventListener("offline", network);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, load, savePosition]);

  const onScroll = useCallback((element: HTMLElement) => {
    const length = element.scrollHeight - element.clientHeight;
    position.current = { id: noteId, ratio: length > 0 ? Math.min(1, Math.max(0, element.scrollTop / length)) : 0, ready: true };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(savePosition, 800);
  }, [noteId, savePosition]);
  return { note, meta, setMeta, loading, error, errorDetail, online, metaError, missing, newer, positionError,
    position, onScroll, savePosition, reload: () => load(true), check: () => load() };
}
