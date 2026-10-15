import { useEffect, useState } from "react";
import { mobileKnowledgeFolders, mobileKnowledgeTags } from "@/lib/api/mobileKnowledge";
import type { MobileArticle } from "@/lib/api/mobileArticle";
import type { NoteFolder } from "@/lib/api/noteFolders";
import type { Tag } from "@/stores/appStore";
import { MobileNotice } from "../ui/MobileNotice";
import type { useKnowledgeArticle } from "./useKnowledgeArticle";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeArticle.module.css";

export function KnowledgeArticleMetadata({ task, busy, change }: {
  task: MobileArticle; busy: boolean; change: ReturnType<typeof useKnowledgeArticle>["change"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let alive = true; setError("");
    // Categories are re-read per expansion; cached child state is not required for correctness.
    void Promise.all([mobileKnowledgeFolders(), mobileKnowledgeTags()]).then(([f,t]) => { if (alive) { setFolders(f); setTags(t); } })
      .catch(() => { if (alive) setError("分类暂时无法读取；正文和备注仍可保存。"); });
    return () => { alive = false; };
  }, [expanded, retry]);
  return <details className={styles.metadata} onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary>分类、备注与来源</summary>
    <label className={styles.label} htmlFor="article-title">标题（可后填）</label>
    <input id="article-title" className={styles.input} disabled={busy} value={task.title} onChange={e => change("title", e.target.value)} />
    {error && <MobileNotice compact tone="warning" title={error} action={<button className={ui.textButton} onClick={() => setRetry(v => v+1)}>重新读取分类</button>} />}
    <label className={styles.label} htmlFor="article-folder">文件夹（可不选）</label>
    <select id="article-folder" className={styles.input} disabled={busy || !!error} value={task.folder_id || ""} onChange={e => change("folder_id", e.target.value || null)}>
      <option value="">未分类</option>
      {task.folder_id && !folders.some(f => f.id === task.folder_id) && <option value={task.folder_id}>原文件夹（待核对）</option>}
      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
    {!!tags.length && <fieldset className={styles.tags}><legend>标签（可不选）</legend>{tags.map(tag => <label key={tag.id} className={styles.tag}><input type="checkbox" disabled={busy} checked={task.tag_ids.includes(tag.id)} onChange={e => change("tag_ids", e.target.checked ? [...task.tag_ids,tag.id] : task.tag_ids.filter(id=>id!==tag.id))} />{tag.name}</label>)}</fieldset>}
    <label className={styles.label} htmlFor="article-remarks">收藏原因（可不填）</label>
    <textarea id="article-remarks" className={styles.textarea} disabled={busy} value={task.remarks} onChange={e => change("remarks", e.target.value)} placeholder="留下当时想记住的事…" />
    <p className={styles.meta}>原链接：{task.url}</p>
  </details>;
}
