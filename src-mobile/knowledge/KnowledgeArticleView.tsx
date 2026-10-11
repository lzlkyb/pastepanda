import { useRef, useState } from "react";
import { ArrowLeft, Check, Clipboard, Link } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { knowledgeArticleUrl, knowledgeErrorText } from "@/lib/utils";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { useMobileBack } from "../ui/useMobileBack";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { KnowledgeArticleMetadata } from "./KnowledgeArticleMetadata";
import type { useKnowledgeArticle } from "./useKnowledgeArticle";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeArticle.module.css";

export function KnowledgeArticleView({ article, active }: { article: ReturnType<typeof useKnowledgeArticle>; active: boolean }) {
  const [url, setUrl] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [linkFeedback, setLinkFeedback] = useState("");
  const [discardId, setDiscardId] = useState<string | null>(null);
  const clipboardEpoch = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const task = article.task;
  const duplicate = task?.duplicate_note_id || (task?.note_id && !task.saved_link_only ? task.note_id : null);
  const missing = task?.images.filter(image => !image.local).length || 0;
  const close = () => { ++clipboardEpoch.current; void article.close(); };
  const rootRef = useRef<HTMLElement>(null);
  useMobileBack(active, close, false, 0, rootRef);
  const read = (text: string) => {
    ++clipboardEpoch.current;
    const link = knowledgeArticleUrl(text);
    if (!link) { setFieldError("请粘贴完整的 http 或 https 文章链接。"); return; }
    setUrl(link); setFieldError(""); void article.begin(link);
  };
  const paste = async () => {
    const token = ++clipboardEpoch.current, target = input.current;
    try {
      const text = await navigator.clipboard.readText();
      if (token !== clipboardEpoch.current || target !== input.current || !target?.isConnected) return;
      read(text);
    } catch { if (token === clipboardEpoch.current && target === input.current) setFieldError("未能读取剪贴板，请长按输入框粘贴。"); }
  };
  const original = async (href: string) => {
    if (!knowledgeArticleUrl(href)) { setLinkFeedback("此地址无法打开，请核对原链接。"); return; }
    try { await openUrl(href); setLinkFeedback("已交给浏览器打开"); }
    catch (cause) { setLinkFeedback(knowledgeErrorText(cause)); }
  };
  return <section ref={rootRef} className={styles.root} aria-label="收藏文章">
    <header className={styles.head}><button className={ui.textButton} disabled={article.saving} onClick={close}><ArrowLeft size={20} aria-hidden="true" />返回</button><h1>{task?.body ? "文章预览" : "收藏文章"}</h1></header>
    <div className={styles.layout}>
      <div className={styles.scroll}>
        {!task && <><h2 className={styles.introTitle}>从微信复制文章链接</h2><p className={styles.meta}>在文章右上角菜单选择“复制链接”，回到这里粘贴。支持可公开访问的文章。</p>
          <form onSubmit={e => { e.preventDefault(); read(url); }}>
            <label className={styles.label} htmlFor="article-url">文章链接</label>
            <textarea ref={input} id="article-url" className={styles.textarea} value={url} disabled={article.busy} aria-invalid={!!fieldError} aria-describedby={fieldError ? "article-url-error" : undefined} onChange={e => { ++clipboardEpoch.current; setUrl(e.target.value); setFieldError(""); }} onPaste={e => { const text=e.clipboardData.getData("text"); if (text.trim()) { e.preventDefault(); read(text); } }} placeholder="https://…" />
            {fieldError && <p id="article-url-error" role="alert" className={styles.fieldError}>{fieldError}</p>}
            <div className={styles.inputActions}><button type="button" className={ui.secondary} disabled={article.busy} onClick={() => void paste()}><Clipboard size={18} aria-hidden="true" />粘贴链接</button><button type="submit" className={ui.primary} disabled={article.busy}>读取文章</button></div>
          </form><p className={styles.meta}>粘贴后直接读取正文；无法取得时，可以明确选择仅存链接。</p></>}
        {task && <>
          {article.busy && !article.saving && <MobileNotice compact tone="pending" title="正在读取文章正文与图片…" detail="链接已保留，可以返回稍后继续。" />}
          {duplicate && <MobileNotice title="这篇文章已经收藏过" detail="已有正文和备注保持原样，直接继续阅读。" />}
          {missing > 0 && !duplicate && <MobileNotice compact tone="warning" title={`${missing} 张配图待补齐`} detail="可先保存正文，稍后补图。" />}
          <article className={styles.article}><h2>{task.title || "待收集文章"}</h2>{task.author && <p className={styles.meta}>{task.author}</p>}
            {task.body ? <KnowledgeMarkdown content={task.body} active={active} onLink={href => void original(href)} /> : <p className={styles.meta}>正文尚未保存在手机。原链接已保留。</p>}
          </article>
          {!duplicate && <KnowledgeArticleMetadata key={task.id} task={task} busy={article.busy} change={article.change} />}
          <button className={ui.textButton} disabled={article.saving} onClick={() => void original(task.url)}><Link size={18} aria-hidden="true" />查看原文</button>
          {task.note_id || task.duplicate_note_id ? <button className={ui.textButton} disabled={article.saving} onClick={close}>保留原笔记并退出</button> : <button className={ui.textButton} disabled={article.saving} onClick={() => setDiscardId(task.id)}>放弃这次收集</button>}
          {linkFeedback && <MobileNotice compact title={linkFeedback} />}
        </>}
      </div>
      {(task || article.error) && <footer className={styles.actions}>
        <div className={styles.feedback}>{article.error && <MobileNotice compact error title={task ? task.note_id ? "原笔记仍保留" : "内容仍保留" : "暂未读取文章"} detail={article.error} />}</div>
        <div className={styles.buttons}>
          {duplicate ? <button className={ui.primary} disabled={article.busy} onClick={() => void article.existing()}>查看已有笔记</button> : task && <>
            {task.body ? <button className={ui.primary} disabled={article.busy} onClick={() => void article.save(false)}><Check size={18} aria-hidden="true" />{article.saving ? "正在保存…" : task.note_id ? "补充到原笔记" : "保存文章"}</button> : <button className={ui.primary} disabled={article.busy} onClick={() => void article.fetch()}>{article.busy ? "正在读取…" : "重新读取正文"}</button>}
            {task.note_id ? <button className={ui.secondary} disabled={article.busy} onClick={() => void article.existing()}>查看已保存链接</button> : <button className={ui.textButton} disabled={article.busy} onClick={() => void article.save(true)}>仅存链接</button>}
          </>}
          {!task && <button className={ui.secondary} onClick={() => void article.begin(url)}>重新读取</button>}
        </div>
      </footer>}
    </div>
    <MobileSheet open={active && !!task && !task.note_id && !task.duplicate_note_id && task.id === discardId} title="放弃文章收集？" onClose={() => setDiscardId(null)} closeDisabled={article.saving} closeBusyLabel="处理中"
      footer={article.error ? <MobileNotice compact error title="请核对文章收集" detail={article.error} /> : undefined}
      actions={<>
        <button type="button" className={ui.secondary} aria-label="保留文章收集" disabled={article.saving} onClick={() => setDiscardId(null)}>保留</button>
        <button type="button" className={ui.danger} aria-label="确认放弃文章收集" disabled={article.saving || !!task?.note_id || !!task?.duplicate_note_id} onClick={() => { if (discardId) void article.discard(discardId).then(done => { if (done) setDiscardId(null); }); }}>{article.saving ? "处理中" : "放弃"}</button>
      </>}>
      <p className={ui.description}>{task?.title || "待收集文章"}</p>
      <p className={ui.description}>只放弃本次文章收集，原分享内容和已有笔记仍保留。此操作无法撤销。</p>
    </MobileSheet>
  </section>;
}
