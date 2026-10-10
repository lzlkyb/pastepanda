import { useEffect, useState } from "react";
import { mobileKnowledgeFolders, mobileKnowledgeTags } from "@/lib/api/mobileKnowledge";
import type { NoteFolder } from "@/lib/api/noteFolders";
import type { Tag } from "@/stores/appStore";
import { knowledgeErrorText } from "@/lib/utils";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeView.module.css";

export function KnowledgeFilters({ open, folder, tag, onClose, onApply }: {
  open: boolean; folder: string; tag: string; onClose: () => void; onApply: (folder: string, tag: string) => void;
}) {
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [chosenFolder, setChosenFolder] = useState(folder);
  const [chosenTag, setChosenTag] = useState(tag);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChosenFolder(folder); setChosenTag(tag); setLoading(true); setError("");
    // Re-read on each opening: sync may have changed categories while this sheet was closed.
    void Promise.all([mobileKnowledgeFolders(), mobileKnowledgeTags()]).then(([f, t]) => {
      if (alive) { setFolders(f); setTags(t); }
    }).catch(cause => { if (alive) setError(knowledgeErrorText(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, folder, tag, retry]);
  return <MobileSheet open={open} title="筛选资料" onClose={onClose} footer={<>
    <button className={ui.secondary} onClick={() => onApply("all", "")}>清除筛选</button>
    <button className={ui.primary} disabled={loading || !!error} onClick={() => onApply(chosenFolder, chosenTag)}>显示结果</button>
  </>}>
    {loading && <MobileNotice tone="pending" title="正在读取文件夹与标签…" />}
    {error && <MobileNotice error title="筛选条件未能读取" detail={error} action={<button className={ui.textButton} onClick={() => setRetry(value => value + 1)}>重新读取</button>} />}
    <label className={styles.field} htmlFor="kb-folder">文件夹</label>
    <select id="kb-folder" className={styles.select} value={chosenFolder} disabled={loading || !!error} onChange={e => setChosenFolder(e.target.value)}>
      <option value="all">全部文件夹</option><option value="unfiled">未分类</option>
      {folders.map(item => <option key={item.id} value={item.id}>{`${"　".repeat(Math.max(0, Math.min(item.depth - 1, 4)))}${item.name}`}</option>)}
    </select>
    <label className={styles.field} htmlFor="kb-tag">标签</label>
    <select id="kb-tag" className={styles.select} value={chosenTag} disabled={loading || !!error} onChange={e => setChosenTag(e.target.value)}>
      <option value="">全部标签</option>{tags.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  </MobileSheet>;
}
