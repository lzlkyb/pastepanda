import { useEffect, useState, type ReactNode } from "react";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import { KnowledgeEditorShell } from "./KnowledgeEditorShell";
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
  return <KnowledgeEditorShell heading="修改笔记" idPrefix="knowledge-edit" title={edit.draft.title} content={edit.draft.content}
    readonly={readonly} saving={edit.saving} status={edit.status || "输入会保留为本机修改草稿。"}
    saveLabel={edit.saving ? "正在保存…" : edit.locked ? "重试核对保存" : "保存修改到手机"}
    onBack={leave} onPreview={() => setPreview(true)} onTitle={value => edit.update("title", value)} onContent={value => edit.update("content", value)}
    onClassification={() => setClassification(true)} onPickImages={onPickImages} onSave={() => void save()}
    feedback={<>
      {operationNotice && <MobileNotice compact {...operationNotice} />}{collectionNotice}
      {edit.error && <MobileNotice compact error title={edit.locked ? "保存结果待核对" : "修改仍保留"} detail={edit.error} />}
      {!edit.error && edit.conflict && <MobileNotice compact tone="warning" title={edit.conflict.status === "deleted" ? "原笔记已不在本机" : "原笔记已有新版本"} detail="手机修改仍保留，可以另存一篇。" action={<button className={ui.textButton} onClick={() => setConflictOpen(true)}>处理版本变化</button>} />}
    </>}>
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
  </KnowledgeEditorShell>;
}
