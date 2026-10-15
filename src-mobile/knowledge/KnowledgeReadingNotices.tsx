import { useEffect, useId, useState } from "react";
import { MobileNotice, type MobileNoticeProps } from "../ui/MobileNotice";
import { MobileFeedbackSlot } from "../ui/MobileFeedbackSlot";
import type { useKnowledgeReading } from "./useKnowledgeReading";
import styles from "./KnowledgeReader.module.css";

/** Reading stays primary; optional metadata/network issues share one recoverable summary. */
export function KnowledgeReadingNotices({ reading }: { reading: ReturnType<typeof useKnowledgeReading> }) {
  const { note, loading, error, missing, newer, online, metaError, positionError } = reading;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const issues: (MobileNoticeProps & { id: string })[] = [];
  if (!online && note) issues.push({ id: "offline", tone: "info", title: "正在阅读本机内容", detail: "手机当前离线；外部链接和图片可能无法加载。" });
  if (newer) issues.push({ id: "newer", title: "本机正文已更新", detail: "继续阅读当前版本，或手动载入新版。", action: <button type="button" onClick={() => void reading.reload()}>载入新版</button> });
  if (metaError) issues.push({ id: "metadata", tone: "warning", title: "阅读偏好未能加载", detail: "正文仍可阅读；常用状态和上次位置暂不可用。", action: <button type="button" onClick={() => void reading.check()}>重试偏好</button> });
  if (positionError) issues.push({ id: "position", tone: "warning", title: "阅读位置未能保存", detail: "正文仍可阅读，返回此页时可能从开头开始。", action: <button type="button" onClick={reading.savePosition}>重试保存位置</button> });
  useEffect(() => { setExpanded(false); }, [note?.id]);
  return <>
    <MobileFeedbackSlot>{loading && !note ? <MobileNotice tone="pending" title="正在读取本机正文…" /> : null}</MobileFeedbackSlot>
    <MobileFeedbackSlot>{error ? <MobileNotice tone="error" title="未能读取笔记" detail={reading.errorDetail} action={<button type="button" onClick={() => void reading.reload()}>重试读取</button>} /> : null}</MobileFeedbackSlot>
    <MobileFeedbackSlot>{missing ? <MobileNotice tone="warning" title="这篇笔记已不在本机知识库中" detail={note ? "当前页面保留已打开的内容，返回后可重新搜索。" : "可能已删除或尚未同步，请返回搜索或检查同步状态。"} /> : null}</MobileFeedbackSlot>
    <MobileFeedbackSlot>{issues.length === 1 ? <MobileNotice compact {...issues[0]} /> : issues.length > 1 ? <MobileNotice compact
      tone={issues.some(issue => issue.tone === "warning") ? "warning" : "info"}
      title={`有 ${issues.length} 项阅读提示`} detail="正文仍可继续阅读。"
      action={<button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>{expanded ? "收起阅读提示" : "查看阅读提示"}</button>} /> : null}</MobileFeedbackSlot>
    <MobileFeedbackSlot>{expanded && issues.length > 1 ? <div id={detailsId} className={styles.readingDetails}>
      {issues.map(({ id, ...issue }) => <MobileNotice key={id} compact {...issue} />)}
    </div> : null}</MobileFeedbackSlot>
  </>;
}
