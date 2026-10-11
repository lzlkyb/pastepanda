import { useEffect, useState } from "react";
import { mobileKnowledgeFolders, mobileKnowledgeTags } from "@/lib/api/mobileKnowledge";
import type { NoteFolder } from "@/lib/api/noteFolders";
import type { Tag } from "@/stores/appStore";
import { knowledgeErrorText } from "@/lib/utils";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeMaintenance.module.css";

export function KnowledgeClassification({ open, folder, tags, onClose, onApply }: {
  open: boolean; folder: string | null; tags: string[]; onClose: () => void;
  onApply: (folder: string | null, tags: string[]) => void;
}) {
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [choices, setChoices] = useState<Tag[]>([]);
  const [selectedFolder, setFolder] = useState(folder);
  const [selectedTags, setTags] = useState(tags);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFolder(folder); setTags(tags); setLoading(true); setError("");
    // The sheet is transient: reload categories each opening, while draft choices live above it.
    void Promise.all([mobileKnowledgeFolders(), mobileKnowledgeTags()]).then(([f, t]) => {
      if (alive) { setFolders(f); setChoices(t); }
    }).catch(cause => { if (alive) setError(knowledgeErrorText(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, folder, tags, retry]);
  return <MobileSheet open={open} title="文件夹与标签" onClose={onClose}
    footer={error && <MobileNotice compact error title="分类条件未能读取" detail={error} />}
    actions={error ? <button className={ui.primary} onClick={() => setRetry(v => v + 1)}>重新读取</button>
      : <button className={ui.primary} disabled={loading} onClick={() => onApply(selectedFolder, selectedTags)}>应用到草稿</button>}>
    {loading && <MobileNotice tone="pending" title="正在读取分类…" />}
    <label className={styles.label} htmlFor="edit-folder">文件夹</label>
    <select id="edit-folder" className={styles.input} value={selectedFolder || ""} disabled={loading || !!error} onChange={e => setFolder(e.target.value || null)}>
      <option value="">未分类</option>
      {selectedFolder && !folders.some(f => f.id === selectedFolder) && <option value={selectedFolder}>原文件夹已不可用，请重新选择</option>}
      {folders.map(f => <option key={f.id} value={f.id}>{`${"　".repeat(Math.min(4, Math.max(0, f.depth - 1)))}${f.name}`}</option>)}
    </select>
    <fieldset className={styles.tags} disabled={loading || !!error}><legend>已有标签</legend>
      {choices.map(t => <label className={styles.tagChoice} key={t.id}><input type="checkbox" checked={selectedTags.includes(t.id)} onChange={e => setTags(v => e.target.checked ? [...v, t.id] : v.filter(id => id !== t.id))} /><span>{t.name}</span></label>)}
      {!loading && !error && choices.length === 0 && <p className={styles.meta}>还没有已有标签，可以先保存，之后在电脑整理。</p>}
      {selectedTags.some(id => !choices.some(t => t.id === id)) && <button className={ui.textButton} onClick={() => setTags(v => v.filter(id => choices.some(t => t.id === id)))}>移除已不可用的标签</button>}
    </fieldset>
    <p className={styles.meta}>这里只修改这篇笔记的分类，不调整电脑上的文件夹结构。</p>
  </MobileSheet>;
}
