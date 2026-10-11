import { useLayoutEffect, useState } from "react";
import type { MobileKnowledgeIncoming } from "@/lib/api/mobileKnowledgeShare";
import { knowledgeCollectedContent } from "@/lib/utils";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeMaintenance.module.css";

export function KnowledgeCollectionSheet({ item, active, busy, error, hasCapture, target, applied = false, saved = false, savePending = false, items = [], onChoose, onClose, onUse, onSave, onDiscard, onContinue }: {
  item: MobileKnowledgeIncoming | null; active: boolean; busy: boolean; error: string;
  hasCapture: boolean; target: "capture" | "edit" | null; onClose: () => void;
  applied?: boolean;
  saved?: boolean;
  savePending?: boolean;
  items?: MobileKnowledgeIncoming[]; onChoose?: (id: string) => void;
  onUse: (item: MobileKnowledgeIncoming) => Promise<void>; onSave: (item: MobileKnowledgeIncoming) => Promise<void>;
  onDiscard: (id: string) => Promise<void>; onContinue: () => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [discard, setDiscard] = useState(false);
  // Switching queued shares must replace their fields before the next visible frame.
  useLayoutEffect(() => { setTitle(item?.title || ""); setText(item?.text || ""); setDiscard(false); }, [item?.id]);
  const blocked = hasCapture && !target && !applied;
  return <MobileSheet open={!!item && active} title={discard ? "放弃这次收集？" : "收集内容预览"} onClose={onClose} closeDisabled={busy} closeBusyLabel={discard ? "处理中" : "保存中"}
    footer={error ? <MobileNotice compact error title={saved ? "笔记已保存" : "收集内容仍保留"} detail={error} /> : undefined} actions={<>
    {discard ? <><button className={ui.secondary} disabled={busy} onClick={() => setDiscard(false)}>保留内容</button><button className={ui.danger} aria-label="确认放弃这次收集" disabled={busy} onClick={() => item && void onDiscard(item.id)}>确认放弃</button></> : <>
      <button className={ui.primary} disabled={busy || blocked || item?.status === "error"} onClick={() => item && void (target || (applied && !savePending) ? onUse : onSave)({ ...item, title, text })}>{busy ? "正在保存…" : applied && !savePending ? "重试清理收集状态" : target ? "加入当前草稿" : "保存到手机"}</button>
      {!target && !saved && <button className={ui.secondary} disabled={busy || blocked || item?.status === "error"} onClick={() => item && void onUse({ ...item, title, text })}>继续编辑</button>}
    </>}
  </>}>
    {item && !discard && <>
      {items.length > 1 && onChoose && <><label className={styles.label} htmlFor="incoming-choice">待收集内容</label><select id="incoming-choice" className={styles.input} value={item.id} disabled={busy} onChange={e => onChoose(e.target.value)}>{items.map((entry, index) => <option key={entry.id} value={entry.id}>{entry.title || `${index + 1} · ${entry.images.length ? `${entry.images.length}张图片` : entry.text.slice(0, 30) || "未能读取的分享"}`}</option>)}</select></>}
      {item.status !== "ready" && <MobileNotice tone={item.status === "error" ? "error" : "warning"} title={item.status === "error" ? "分享内容未能读取" : "部分内容可用"} detail={item.message || "来源内容可能已过期。已有内容仍保留，请返回来源App重新分享。"} />}
      {blocked && <MobileNotice title="先处理正在写的记录" detail="这次分享已单独保留，不会覆盖原草稿。" action={<button className={ui.textButton} disabled={busy} onClick={onContinue}>继续已有草稿</button>} />}
      {applied && <MobileNotice title={saved ? "笔记已保存到手机" : "内容已加入草稿"} detail={saved ? "重试只清理待收集状态，不会重复创建笔记。" : "重试不会重复追加。需要改动内容时，可以关闭预览回到草稿。"} />}
      {target ? <p className={styles.meta}>选中的图片会加入当前草稿；草稿落盘后才清理这次收集。</p> : <p className={styles.meta}>核对后直接保存，或继续编辑补充内容。链接网页不会自动下载。</p>}
      <button className={ui.textButton} disabled={busy} onClick={() => setDiscard(true)}>放弃这次收集</button>
      {!target && <><label className={styles.label} htmlFor="incoming-title">标题（可后填）</label><input id="incoming-title" className={styles.input} value={title} disabled={busy || applied} onChange={e => setTitle(e.target.value)} />
        <label className={styles.label} htmlFor="incoming-text">文字与备注</label><textarea id="incoming-text" className={styles.textarea} value={text} disabled={busy || applied} onChange={e => setText(e.target.value)} /></>}
      {!!item.images.length && <><p className={styles.meta}>{item.images.length} 张图片已存到手机。</p><KnowledgeMarkdown content={knowledgeCollectedContent("", item.images)} active={active} onLink={() => undefined} /></>}
    </>}
    {discard && <p className={styles.meta}>只移除本次待收集内容，不删除已有笔记或正在编辑的草稿。</p>}
  </MobileSheet>;
}
