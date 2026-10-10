import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import type { useKnowledgeArticleReading } from "./useKnowledgeArticleReading";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeArticleReadingNotice.module.css";

type Props = { article: ReturnType<typeof useKnowledgeArticleReading>; onFill?: (id: string) => void; onOriginal: (url: string) => void };
export function KnowledgeArticleReadingNotice(props: Props) {
  const { article } = props;
  if (!article.task?.saved_link_only && !article.missing && !article.error) return null;
  // "Later" belongs to this note and this outcome, never to a newly failed request.
  return <ReadingStatus key={`${article.noteId}:${article.task?.id ?? ""}`} {...props} />;
}

function ReadingStatus({ article, onFill, onOriginal }: Props) {
  const [expanded, setExpanded] = useState(false), [later, setLater] = useState(false);
  const detailsId = useId();
  useEffect(() => {
    // Clearing an old error starts a retry; keep its progress in the same open
    // details. Only a new failure revokes the previous "later" choice.
    if (article.error) { setExpanded(false); setLater(false); }
  }, [article.error]);
  const linkOnly = !!article.task?.saved_link_only;
  const title = article.busy ? "正在补齐图片…" : linkOnly ? "仅保存了链接" : article.missing ? `${article.missing} 张图片待补齐` : "收藏状态待核对";
  return <section className={styles.notice} aria-label="文章收藏状态">
    <div className={styles.summary}>
      <button type="button" className={styles.toggle} aria-label={`查看收藏状态：${title}`}
        aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => { setLater(false); setExpanded(value => !value); }}>
        <Info size={18} aria-hidden="true" /><span>{later ? "收藏状态" : title}{!later && article.error && article.missing && !linkOnly ? " · 补齐未完成" : !later && article.error && linkOnly ? " · 状态待核对" : ""}</span>
        {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {!later && <button type="button" className={styles.later} aria-label="稍后处理" onClick={() => { setExpanded(false); setLater(true); }}>稍后</button>}
    </div>
    {expanded && <div id={detailsId} className={styles.details}>
      <p>{linkOnly ? "正文尚未保存在手机。" : article.missing ? "正文与已有图片仍保留；可以逐张补齐，也可以补齐剩余图片。" : "正文仍可阅读。"}</p>
      {article.error && <p role="status" className={styles.error}>{article.error}</p>}
      <div className={styles.actions}>
        {linkOnly && onFill && <button type="button" className={ui.textButton} onClick={() => onFill(article.task!.id)}>读取并补充正文</button>}
        {linkOnly && <button type="button" className={ui.textButton} onClick={() => onOriginal(article.task!.url)}>查看原文</button>}
        {!linkOnly && article.missing > 0 && <button type="button" className={ui.textButton} disabled={article.busy} onClick={() => void article.recoverAll()}>{article.busy ? "正在补齐…" : "补齐剩余图片"}</button>}
        {article.error && <button type="button" className={ui.textButton} disabled={article.busy} onClick={article.retry}>重新核对收藏状态</button>}
        <button type="button" className={ui.textButton} onClick={() => setExpanded(false)}>收起详情</button>
      </div>
    </div>}
  </section>;
}
