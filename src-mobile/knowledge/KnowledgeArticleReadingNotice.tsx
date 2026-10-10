import { MobileNotice } from "../ui/MobileNotice";
import type { useKnowledgeArticleReading } from "./useKnowledgeArticleReading";
import ui from "../ui/MobileUi.module.css";

export function KnowledgeArticleReadingNotice({ article, onFill, onOriginal }: {
  article: ReturnType<typeof useKnowledgeArticleReading>; onFill?: (id: string) => void; onOriginal: (url: string) => void;
}) {
  return <>
    {article.task?.saved_link_only && <MobileNotice compact title="仅保存了链接" detail="正文尚未保存在手机。" action={<>
      {onFill && <button className={ui.textButton} onClick={() => onFill(article.task!.id)}>读取并补充正文</button>}
      <button className={ui.textButton} onClick={() => onOriginal(article.task!.url)}>查看原文</button>
    </>} />}
    {!article.task?.saved_link_only && article.missing > 0 && <MobileNotice compact tone="warning" title={`正文已保存，${article.missing} 张图片待补齐`} detail="可以逐张补齐，也可以补齐剩余图片。" action={<button className={ui.textButton} disabled={article.busy} onClick={() => void article.recoverAll()}>{article.busy ? "正在补齐…" : "补齐剩余图片"}</button>} />}
    {article.error && <MobileNotice compact tone="warning" title="正文与已有图片仍保留" detail={article.error} action={<button className={ui.textButton} disabled={article.busy} onClick={article.retry}>重新核对收藏状态</button>} />}
  </>;
}
