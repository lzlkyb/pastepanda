import { useState, type ReactNode } from "react";
import { ArrowLeft, ImagePlus } from "lucide-react";
import { copyToClipboard } from "@/lib/utils";
import { MobileNotice, type MobileFeedback } from "../ui/MobileNotice";
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
  const [copyResult, setCopyResult] = useState<boolean | null>(null);
  const [previewLink, setPreviewLink] = useState(false);
  const leave = () => { setPreview(false); void draft.flush().then(onBack).catch(() => undefined); };
  // A failed flush keeps the editor open; keep its back layer until leaving succeeds.
  useMobileBack(active && !preview, leave, true);
  if (!draft.draft) return null;
  const readonly = draft.saving || draft.locked;
  return <div className={styles.editor}>
    <header className={styles.head}>
      <button className={ui.textButton} aria-label="返回并保留草稿" disabled={draft.saving} onClick={leave}><ArrowLeft size={20} aria-hidden="true" /></button>
      <h1>新建笔记</h1><button className={ui.textButton} onClick={() => setPreview(true)}>预览</button>
    </header>
    <div className={styles.scroll}>
      {draft.error && <MobileNotice error title={draft.locked ? "正在核对保存结果" : "内容尚未保存"} detail={draft.error} action={<button className={ui.textButton} onClick={() => void copyToClipboard(draft.draft!.content).then(setCopyResult)}>复制内容备用</button>} />}
      {copyResult !== null && <MobileNotice tone={copyResult ? "success" : "error"} title={copyResult ? "已复制内容" : "复制未能完成"} />}
      <label className={styles.field} htmlFor="knowledge-title">标题（可后填）</label>
      <input id="knowledge-title" className={styles.input} value={draft.draft.title} placeholder="用一句话记住它" readOnly={readonly} onChange={e => draft.update("title", e.target.value)} />
      <label className={styles.field} htmlFor="knowledge-content">内容</label>
      <textarea id="knowledge-content" className={styles.textarea} value={draft.draft.content} placeholder="记下需要保留的内容…" readOnly={readonly} onChange={e => draft.update("content", e.target.value)} />
      <p className={styles.meta} role="status">{draft.status || "输入会保存为本机草稿。"}</p>
      {onPickImages && <button className={ui.secondary} disabled={readonly} onClick={onPickImages}><ImagePlus size={20} aria-hidden="true" />添加图片</button>}
      <p className={styles.meta}>保存到未分类，稍后可在手机修改时选择文件夹与标签。</p>
    </div>
    <footer className={styles.footer}>
      <div className={styles.footerFeedback}>
      {operationNotice && <MobileNotice compact {...operationNotice} />}
      {collectionNotice}
      {draft.error && <p className={styles.saveError} role="alert">{draft.locked ? "保存结果待核对，请重试" : "尚未保存，请重试"}</p>}
      </div>
      <button className={ui.primary} disabled={draft.saving} onClick={() => void draft.save().then(note => { if (note) onSaved(note.id); })}>
        {draft.saving ? "正在保存…" : draft.error ? "重试保存到手机" : "保存到手机"}
      </button>
    </footer>
    <MobileSheet open={preview && active} title="记录预览" onClose={() => { setPreview(false); setPreviewLink(false); }} footer={previewLink ? <MobileNotice title="当前是草稿预览" detail="保存后可在全文中打开链接。" /> : undefined}>
      <h2>{draft.draft.title || "未命名记录"}</h2>{draft.draft.content ? <KnowledgeMarkdown content={draft.draft.content} active={active && preview} onLink={() => setPreviewLink(true)} /> : <p className={styles.meta}>还没有正文</p>}
      <button className={ui.primary} onClick={() => setPreview(false)}>继续写</button>
    </MobileSheet>
  </div>;
}
