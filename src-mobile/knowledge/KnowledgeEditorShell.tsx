import type { ReactNode } from "react";
import { ArrowLeft, Folder, ImagePlus } from "lucide-react";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeEditorShell.module.css";

/** Shared visual workspace; each draft model still owns its save/retention semantics. */
export function KnowledgeEditorShell({ heading, idPrefix, title, content, titleOptional, readonly, saving, status, saveLabel, feedback, onBack, onPreview, onTitle, onContent, onClassification, onPickImages, onSave, children }: {
  heading: string; idPrefix: string; title: string; content: string; titleOptional?: boolean;
  readonly: boolean; saving: boolean; status: string; saveLabel: string; feedback?: ReactNode;
  onBack: () => void; onPreview: () => void; onTitle: (value: string) => void; onContent: (value: string) => void;
  onClassification: () => void; onPickImages?: () => void; onSave: () => void; children?: ReactNode;
}) {
  return <div className={styles.root}>
    <header className={styles.head}>
      <button className={ui.textButton} aria-label="返回并保留草稿" disabled={saving} onClick={onBack}><ArrowLeft size={20} aria-hidden="true" /></button>
      <h1>{heading}</h1><button className={ui.textButton} onClick={onPreview}>预览</button>
    </header>
    <div className={styles.scroll}>
      <label className={styles.label} htmlFor={`${idPrefix}-title`}>{titleOptional ? "标题（可后填）" : "标题"}</label>
      <input id={`${idPrefix}-title`} className={styles.input} value={title} placeholder="用一句话记住它" readOnly={readonly} onChange={e => onTitle(e.target.value)} />
      <label className={styles.label} htmlFor={`${idPrefix}-content`}>内容</label>
      <textarea id={`${idPrefix}-content`} className={styles.textarea} value={content} placeholder="记下需要保留的内容…" readOnly={readonly} onChange={e => onContent(e.target.value)} />
      <p className={styles.meta} role="status">{status}</p>
      <div className={styles.tools}>
        <button className={ui.secondary} disabled={readonly} onClick={onClassification}><Folder size={20} aria-hidden="true" />文件夹与标签</button>
        {onPickImages && <button className={ui.secondary} disabled={readonly} onClick={onPickImages}><ImagePlus size={20} aria-hidden="true" />添加图片</button>}
      </div>
    </div>
    <footer className={styles.footer}>
      <div className={styles.feedback}>{feedback}</div>
      <button className={ui.primary} disabled={saving} onClick={onSave}>{saveLabel}</button>
    </footer>
    {children}
  </div>;
}
