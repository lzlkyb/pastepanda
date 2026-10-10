import { useEffect, useMemo, useRef, useState } from "react";
import { mobileArticleForNote, mobileArticleImageFetch, type MobileArticle } from "@/lib/api/mobileArticle";
import { knowledgeArticleImageIndex, knowledgeArticleErrorText } from "@/lib/utils";

export function useKnowledgeArticleReading(noteId: string, active: boolean, content: string, reload: () => Promise<unknown>) {
  const [task, setTask] = useState<MobileArticle | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const working = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const token = ++epoch.current; setTask(null); setError(""); setBusy(false);
    if (!active) return;
    void mobileArticleForNote(noteId).then(value => { if (epoch.current === token) setTask(value || null); })
      .catch(() => { if (epoch.current === token) setError("文章收藏状态暂时无法读取，正文仍可阅读。"); });
    return () => { epoch.current = token + 1; };
  }, [noteId, active, retry]);
  const sources = useMemo(() => (task?.images || []).flatMap(image => [image.url, ...(image.local ? [image.local] : [])]), [task]);
  const recover = async (src: string): Promise<boolean> => {
    if (!task || working.current) return false;
    const index = knowledgeArticleImageIndex(task.images, src);
    if (index < 0) return false;
    const token = epoch.current; working.current = true; setBusy(true); setError("");
    try {
      const value = await mobileArticleImageFetch(task.id, index);
      if (token !== epoch.current) return false;
      setTask(value); await reload(); return true;
    } catch (cause) { if (token === epoch.current) setError(knowledgeArticleErrorText(cause)); return false; }
    finally { working.current = false; if (token === epoch.current) setBusy(false); }
  };
  const missing = (task?.images || []).filter(image => !image.local && content.includes(image.url));
  const recoverAll = async () => {
    for (const image of missing) { if (!await recover(image.url)) break; }
  };
  return { task, sources, missing: missing.length, busy, error, recover, recoverAll, retry: () => setRetry(v=>v+1) };
}
