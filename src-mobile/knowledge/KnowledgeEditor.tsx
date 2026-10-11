import { useState, type ReactNode } from "react";
import { copyToClipboard } from "@/lib/utils";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
import { MobileFeedbackSlot } from "../ui/MobileFeedbackSlot";
import { MobileToast } from "../ui/MobileToast";
import { KnowledgeClassification } from "./KnowledgeClassification";
import { KnowledgeEditorShell } from "./KnowledgeEditorShell";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import { MobileConfirmSheet } from "../ui/MobileConfirmSheet";
import { useKnowledgeDraftExit } from "./useKnowledgeDraftExit";
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
  const exit = useKnowledgeDraftExit(draft.flush, onBack);
  const leave = () => { setPreview(false); exit.leave(); };
  // A failed flush keeps the editor open; keep its back layer until leaving succeeds.
  useMobileBack(active && !preview && !classification && !exit.error, leave, true);
  if (!draft.draft) return null;
  const readonly = draft.saving || draft.locked || exit.busy;
  return <KnowledgeEditorShell heading="新建笔记" idPrefix="knowledge" title={draft.draft.title} content={draft.draft.content} titleOptional
    readonly={readonly} saving={draft.saving || exit.busy} status={exit.busy ? "正在保存草稿…" : draft.status || "输入会保存为本机草稿。"}
    saveLabel={draft.saving ? "正在保存…" : draft.error ? "重试保存到手机" : "保存到手机"}
    onBack={leave} onPreview={() => setPreview(true)} onTitle={value => draft.update("title", value)} onContent={value => draft.update("content", value)}
    onClassification={() => setClassification(true)} onPickImages={onPickImages} onSave={() => void draft.save().then(note => { if (note) onSaved(note.id); })}
    feedback={<>
      <MobileFeedbackSlot>{operationNotice && <MobileNotice compact {...operationNotice} />}</MobileFeedbackSlot>{collectionNotice}
      <MobileFeedbackSlot>{draft.error ? <MobileNotice compact error title={draft.locked ? "保存结果待核对" : "内容尚未保存"} detail={draft.error}
        action={<button className={ui.textButton} onClick={() => void copyToClipboard(draft.draft!.content).then(setCopyResult)}>复制内容备用</button>} /> : null}</MobileFeedbackSlot>
      <MobileFeedbackSlot>{copyResult !== null ? (copyResult
        ? <MobileToast compact tone="success" title="已复制内容" onDismiss={() => setCopyResult(null)} />
        : <MobileNotice compact error title="复制未能完成" detail="内容仍保留，请重试复制。" onDismiss={() => setCopyResult(null)} />) : null}</MobileFeedbackSlot>
    </>}>
    <KnowledgeClassification open={classification && active} folder={draft.draft.folder_id || null} tags={draft.draft.tag_ids || []} onClose={() => setClassification(false)} onApply={(folder, tags) => {
      draft.update("folder_id", folder); draft.update("tag_ids", tags); setClassification(false);
    }} />
    <MobileSheet open={preview && active} title="记录预览" onClose={() => { setPreview(false); setPreviewLink(false); }} footer={previewLink ? <MobileNotice title="当前是草稿预览" detail="保存后可在全文中打开链接。" /> : undefined}>
      <h2>{draft.draft.title || "未命名记录"}</h2>{draft.draft.content ? <KnowledgeMarkdown content={draft.draft.content} active={active && preview} onLink={() => setPreviewLink(true)} /> : <p className={styles.meta}>还没有正文</p>}
      <button className={ui.primary} onClick={() => setPreview(false)}>继续写</button>
    </MobileSheet>
    <MobileConfirmSheet open={active && !!exit.error} title="草稿尚未保存" danger={false}
      description="内容仍保留在当前页面。继续编辑，或重试保存草稿后离开。" error={exit.error}
      cancelLabel="继续编辑" confirmLabel="重试保存后离开" busy={exit.busy} onCancel={exit.cancel} onConfirm={exit.leave} />
  </KnowledgeEditorShell>;
}
