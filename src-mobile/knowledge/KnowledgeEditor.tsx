import { useState, type ReactNode } from "react";
import { copyToClipboard } from "@/lib/utils";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { KnowledgeClassification } from "./KnowledgeClassification";
import { KnowledgeEditorShell } from "./KnowledgeEditorShell";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import type { useKnowledgeDraft } from "./useKnowledgeDraft";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeView.module.css";

export function KnowledgeEditor({ draft, active, onBack, onSaved, onPickImages, operationNotice, collectionNotice }: {
  draft: ReturnType<typeof useKnowledgeDraft>; active: boolean; onBack: () => void; onSaved: (id: string) => void;
  onPickImages?: () => void; operationNotice?: MobileFeedback;
  collectionNotice?: ReactNode;
}) {
  const [preview, setPreview] = useState(false);
  const [classification, setClassification] = useState(false);
  const [copyResult, setCopyResult] = useState<boolean | null>(null);
  const [previewLink, setPreviewLink] = useState(false);
  const leave = () => { setPreview(false); void draft.flush().then(onBack).catch(() => undefined); };
  // A failed flush keeps the editor open; keep its back layer until leaving succeeds.
  useMobileBack(active && !preview && !classification, leave, true);
  if (!draft.draft) return null;
  const readonly = draft.saving || draft.locked;
  return <KnowledgeEditorShell heading="新建笔记" idPrefix="knowledge" title={draft.draft.title} content={draft.draft.content} titleOptional
    readonly={readonly} saving={draft.saving} status={draft.status || "输入会保存为本机草稿。"}
    saveLabel={draft.saving ? "正在保存…" : draft.error ? "重试保存到手机" : "保存到手机"}
    onBack={leave} onPreview={() => setPreview(true)} onTitle={value => draft.update("title", value)} onContent={value => draft.update("content", value)}
    onClassification={() => setClassification(true)} onPickImages={onPickImages} onSave={() => void draft.save().then(note => { if (note) onSaved(note.id); })}
    feedback={<>
      {operationNotice && <MobileNotice compact {...operationNotice} />}{collectionNotice}
      {draft.error && <MobileNotice compact error title={draft.locked ? "保存结果待核对" : "内容尚未保存"} detail={draft.error}
        action={<button className={ui.textButton} onClick={() => void copyToClipboard(draft.draft!.content).then(setCopyResult)}>复制内容备用</button>} />}
      {copyResult !== null && <MobileNotice compact tone={copyResult ? "success" : "error"} title={copyResult ? "已复制内容" : "复制未能完成"} />}
    </>}>
    <KnowledgeClassification open={classification && active} folder={draft.draft.folder_id || null} tags={draft.draft.tag_ids || []} onClose={() => setClassification(false)} onApply={(folder, tags) => {
      draft.update("folder_id", folder); draft.update("tag_ids", tags); setClassification(false);
    }} />
    <MobileSheet open={preview && active} title="记录预览" onClose={() => { setPreview(false); setPreviewLink(false); }} footer={previewLink ? <MobileNotice title="当前是草稿预览" detail="保存后可在全文中打开链接。" /> : undefined}>
      <h2>{draft.draft.title || "未命名记录"}</h2>{draft.draft.content ? <KnowledgeMarkdown content={draft.draft.content} active={active && preview} onLink={() => setPreviewLink(true)} /> : <p className={styles.meta}>还没有正文</p>}
      <button className={ui.primary} onClick={() => setPreview(false)}>继续写</button>
    </MobileSheet>
  </KnowledgeEditorShell>;
}
