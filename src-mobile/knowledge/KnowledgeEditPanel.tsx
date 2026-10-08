import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Folder, ImagePlus } from "lucide-react";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { KnowledgeClassification } from "./KnowledgeClassification";
import type { useKnowledgeEdit } from "./useKnowledgeEdit";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeMaintenance.module.css";

export function KnowledgeEditPanel({ edit, active, onBack, onSaved, onPickImages, operationNotice, collectionNotice }: {
  edit: ReturnType<typeof useKnowledgeEdit>; active: boolean; onBack: () => void;
  onSaved: (id: string, copied: boolean, relinked: number) => void;
  onPickImages?: () => void;
  operationNotice?: MobileFeedback;
  collectionNotice?: ReactNode;
}) {
  const [preview, setPreview] = useState(false);
  const [classification, setClassification] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [previewFeedback, setPreviewFeedback] = useState(false);
  const leave = () => { void edit.flush().then(onBack).catch(() => undefined); };
  useMobileBack(active && !preview && !classification && !conflictOpen, leave, true);
  useEffect(() => { if (edit.conflict) setConflictOpen(true); }, [edit.conflict]);
  if (!edit.draft) return null;
  const readonly = edit.saving || edit.locked;
  const save = async (copy = false) => {
    const result = await edit.save(copy);
    if (result) onSaved(result.note.id, result.copied, result.relinked);
  };
  return <div className={styles.root}>
    <header className={styles.head}><button className={ui.textButton} aria-label="返回并保留修改草稿" disabled={edit.saving} onClick={leave}><ArrowLeft size={20} aria-hidden="true" /></button><h1>修改笔记</h1><button className={ui.textButton} onClick={() => setPreview(true)}>预览</button></header>
    <div className={styles.scroll}>
      <p className={styles.meta}>修改保存前会核对原笔记版本；有新版本时保留你的输入。</p>
      <label className={styles.label} htmlFor="knowledge-edit-title">标题</label>
      <input className={styles.input} id="knowledge-edit-title" value={edit.draft.title} readOnly={readonly} onChange={e => edit.update("title", e.target.value)} />
      <label className={styles.label} htmlFor="knowledge-edit-content">内容</label>
      <textarea className={styles.textarea} id="knowledge-edit-content" value={edit.draft.content} readOnly={readonly} onChange={e => edit.update("content", e.target.value)} />
      <p className={styles.meta} role="status">{edit.status || "输入会保留为本机修改草稿。"}</p>
      <div className={styles.actions}><button className={ui.secondary} disabled={readonly} onClick={() => setClassification(true)}><Folder size={20} aria-hidden="true" />文件夹与标签</button>
        {onPickImages && <button className={ui.secondary} disabled={readonly} onClick={onPickImages}><ImagePlus size={20} aria-hidden="true" />添加图片</button>}
      </div>
    </div>
    <footer className={styles.footer}>
      <div className={styles.feedback}>
      {operationNotice && <MobileNotice compact {...operationNotice} />}
      {collectionNotice}
      {edit.error && <MobileNotice error title={edit.locked ? "保存结果待核对" : "修改仍保留"} detail={edit.error} />}
      {!edit.error && edit.conflict && <MobileNotice tone="warning" title={edit.conflict.status === "deleted" ? "原笔记已不在本机" : "原笔记已有新版本"} detail="手机修改仍保留，可以另存一篇。" action={<button className={ui.textButton} onClick={() => setConflictOpen(true)}>处理版本变化</button>} />}
      </div>
      <button className={ui.primary} disabled={edit.saving} onClick={() => void save()}>{edit.saving ? "正在保存…" : edit.locked ? "重试核对保存" : "保存修改到手机"}</button>
    </footer>
    <MobileSheet open={preview && active} title="修改预览" onClose={() => { setPreview(false); setPreviewFeedback(false); }} footer={previewFeedback ? <MobileNotice title="当前是草稿预览" detail="保存后可在全文中打开链接。" /> : undefined}>
      <h2>{edit.draft.title || "未命名笔记"}</h2><KnowledgeMarkdown content={edit.draft.content} active={active && preview} onLink={() => setPreviewFeedback(true)} />
    </MobileSheet>
    <KnowledgeClassification open={classification && active} folder={edit.draft.folder_id} tags={edit.draft.tag_ids} onClose={() => setClassification(false)} onApply={(folder, tags) => {
      edit.update("folder_id", folder); edit.update("tag_ids", tags); setClassification(false);
    }} />
    <MobileSheet open={conflictOpen && active && !!edit.conflict} title="保留手机修改" onClose={() => setConflictOpen(false)} footer={<>
      {edit.error && <MobileNotice error title="修改仍保留" detail={edit.error} />}
      <button className={ui.primary} disabled={readonly} onClick={() => void save(true)}>手机修改另存一篇</button>
      {edit.locked && <MobileNotice title="先核对上一次保存" detail="结果尚未确认，输入暂时只读；返回后重试同一次保存，不另存重复笔记。" />}
      <button className={ui.secondary} disabled={edit.saving} onClick={() => setConflictOpen(false)}>{edit.locked ? "返回核对保存" : "继续修改草稿"}</button>
    </>}>
      <p className={styles.meta}>{edit.conflict?.status === "deleted" ? "原笔记可能已删除或尚未同步。另存会新建独立笔记，不恢复原笔记。" : "本机原笔记在你编辑期间已更新。这里保留两份内容，不直接覆盖新版。"}</p>
      <h3>手机修改</h3><p className={styles.version}>{edit.draft.title}{"\n\n"}{edit.draft.content}</p>
      {edit.conflict?.status === "conflict" && <><h3>本机当前版本</h3><p className={styles.version}>{edit.conflict.latest.title}{"\n\n"}{edit.conflict.latest.content}</p></>}
    </MobileSheet>
  </div>;
}
