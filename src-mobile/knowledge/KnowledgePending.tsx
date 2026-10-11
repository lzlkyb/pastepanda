import { useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import type { MobileArticle } from "@/lib/api/mobileArticle";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgePending.module.css";

type PendingDraft = { id: string; title: string; busy: boolean; locked: boolean; error: string; resume: () => void; discard: () => Promise<boolean> };
type Props = {
  active: boolean;
  draft?: PendingDraft;
  edit?: PendingDraft;
  articles: MobileArticle[];
  incoming: { id: string }[];
  onArticle: (id: string) => void;
  onIncoming: () => void;
};

/** Own only the sheet state: drafts and collection state stay in their existing hooks. */
export function KnowledgePending(props: Props) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "draft" | "edit"; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const candidate = confirm ? props[confirm.kind] : undefined;
  const target = candidate?.id === confirm?.id ? candidate : undefined;
  const editing = confirm?.kind === "edit";
  const noun = editing ? "修改" : "草稿";
  const sources = new Set(props.articles.flatMap(task => task.source_ids));
  const incoming = props.incoming.filter(item => !sources.has(item.id)).length;
  const count = Number(!!props.draft) + Number(!!props.edit) + props.articles.length + incoming;
  if (!count && !open) return null;
  const choose = (action: () => void) => { setOpen(false); action(); };
  const close = () => { if (!busy) { setOpen(false); setConfirm(null); } };
  const keep = () => { if (!busy) { setConfirm(null); setFailed(false); } };
  const discard = async () => {
    if (!target || busy || target.busy || target.locked) return;
    setBusy(true); setFailed(false);
    try {
      // Confirmation names one durable slot; never discard a later replacement task.
      if (await target.discard()) { setNotice(`已放弃${noun}`); setConfirm(null); }
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const row = (kind: "draft" | "edit", item?: PendingDraft) => item && <div className={styles.draft}>
    <button type="button" disabled={busy || item.busy} onClick={() => choose(item.resume)}><span>{kind === "edit" ? "继续修改" : "继续写"}</span><small>{item.title || (kind === "edit" ? "未命名笔记" : "未命名记录")}</small></button>
    <button type="button" className={styles.discard} disabled={busy || item.busy || item.locked} onClick={() => { setConfirm({ kind, id: item.id }); setFailed(false); setNotice(""); }}>{kind === "edit" ? "放弃修改" : "放弃草稿"}</button>
    {item.locked && <p className={styles.explanation}>保存结果尚未确认，请先继续{kind === "edit" ? "修改" : "写"}核对结果。</p>}
  </div>;
  const failures = props.articles.filter(task => task.error).length;
  return <>
    {count > 0 && <button type="button" className={styles.summary} onClick={() => { setOpen(true); setNotice(""); }} aria-haspopup="dialog">
      <Inbox size={20} aria-hidden="true" /><span>待处理 · {count} 项{failures > 0 && <small>{failures} 篇文章需要重试</small>}</span><ChevronRight size={18} aria-hidden="true" />
    </button>}
    <MobileSheet open={open && props.active} title={target ? `放弃${noun}？` : "待处理"} onClose={close}
      footer={(busy || failed && target || notice) ? <div className={styles.result}>{target ? busy ? <MobileNotice compact tone="pending" title={`正在放弃${noun}…`} /> : <MobileNotice compact error title={`${noun}仍保留`} detail={target.error || "未能清除，请重试。"} /> : <MobileNotice compact tone="success" title={notice} />}</div> : undefined}
      actions={target && <>
      <button type="button" className={ui.secondary} aria-label={`保留${noun}`} disabled={busy} onClick={keep}>保留</button>
      <button type="button" className={ui.danger} aria-label={busy ? `正在放弃${noun}` : `确认放弃${noun}`} disabled={busy || target.busy || target.locked} onClick={() => void discard()}>{busy ? "处理中" : "放弃"}</button>
    </>}>
      {target ? <>
        <p className={styles.title}>{target.title || (editing ? "未命名笔记" : "未命名记录")}</p>
        <p className={ui.description}>{editing ? "原笔记不受影响，仅清除这份未保存的修改。此操作无法撤销。" : "只清除这份未保存的草稿，不删除已有笔记。此操作无法撤销。"}</p>
      </> : <>
      {!count && <p className={ui.description}>没有待处理内容。</p>}
      <div className={styles.tasks}>
        {row("draft", props.draft)}
        {row("edit", props.edit)}
        {props.articles.map(task => <button type="button" key={task.id} onClick={() => choose(() => props.onArticle(task.id))}>{task.title || "继续收藏文章"}<small>{task.error ? "文章未能完整收集，打开后重试" : "待收集文章"}</small></button>)}
        {incoming > 0 && <button type="button" onClick={() => choose(props.onIncoming)}>查看收集内容<small>{incoming} 条分享内容 · 已有草稿会保留</small></button>}
      </div>
      </>}
    </MobileSheet>
  </>;
}
