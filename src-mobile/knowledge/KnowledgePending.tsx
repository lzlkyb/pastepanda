import { useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import type { MobileArticle } from "@/lib/api/mobileArticle";
import { MobileSheet } from "../ui/MobileSheet";
import styles from "./KnowledgePending.module.css";

type Props = {
  active: boolean;
  draftTitle?: string;
  editTitle?: string;
  articles: MobileArticle[];
  incoming: { id: string }[];
  onDraft: () => void;
  onEdit: () => void;
  onArticle: (id: string) => void;
  onIncoming: () => void;
};

/** Own only the sheet state: drafts and collection state stay in their existing hooks. */
export function KnowledgePending(props: Props) {
  const [open, setOpen] = useState(false);
  const sources = new Set(props.articles.flatMap(task => task.source_ids));
  const incoming = props.incoming.filter(item => !sources.has(item.id)).length;
  const count = Number(props.draftTitle !== undefined) + Number(props.editTitle !== undefined) + props.articles.length + incoming;
  if (!count) return null;
  const choose = (action: () => void) => { setOpen(false); action(); };
  const failures = props.articles.filter(task => task.error).length;
  return <>
    <button type="button" className={styles.summary} onClick={() => setOpen(true)} aria-haspopup="dialog">
      <Inbox size={20} aria-hidden="true" /><span>待处理 · {count} 项{failures > 0 && <small>{failures} 篇文章需要重试</small>}</span><ChevronRight size={18} aria-hidden="true" />
    </button>
    <MobileSheet open={open && props.active} title="待处理" onClose={() => setOpen(false)}>
      <div className={styles.tasks}>
        {props.draftTitle !== undefined && <button type="button" onClick={() => choose(props.onDraft)}>继续写<small>{props.draftTitle || "未命名记录"}</small></button>}
        {props.editTitle !== undefined && <button type="button" onClick={() => choose(props.onEdit)}>继续修改<small>{props.editTitle || "未命名笔记"}</small></button>}
        {props.articles.map(task => <button type="button" key={task.id} onClick={() => choose(() => props.onArticle(task.id))}>{task.title || "继续收藏文章"}<small>{task.error ? "文章未能完整收集，打开后重试" : "待收集文章"}</small></button>)}
        {incoming > 0 && <button type="button" onClick={() => choose(props.onIncoming)}>查看收集内容<small>{incoming} 条分享内容 · 已有草稿会保留</small></button>}
      </div>
    </MobileSheet>
  </>;
}
