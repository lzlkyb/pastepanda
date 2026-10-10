import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MobileNoteSummary } from "@/lib/api/mobileKnowledge";
import { relativeTime } from "@/lib/utils";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeView.module.css";

export function KnowledgeList({ items, loading, hasMore, error, cancelled, scrollElement, view, query, folder, tag, selected, onQuery, onView, onFilter, onClear, onOpen, onRetry, onMore, onNew, onCancel }: {
  items: MobileNoteSummary[]; loading: boolean; hasMore: boolean; error: string; view: "recent" | "common" | "all"; query: string; folder: string; tag: string; selected: string | null;
  cancelled: boolean; scrollElement: RefObject<HTMLDivElement | null>;
  onQuery: (query: string) => void; onView: (view: "recent" | "common" | "all") => void; onFilter: () => void; onClear: () => void; onOpen: (id: string) => void; onRetry: () => void; onMore: () => void; onNew: () => void; onCancel: () => void;
}) {
  const filtered = !!query || folder !== "all" || !!tag;
  const list = useRef<HTMLUListElement>(null);
  const [margin, setMargin] = useState(0);
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => scrollElement.current,
    estimateSize: () => 152, overscan: 5, getItemKey: index => items[index].id, scrollMargin: margin,
    initialRect: { width: window.innerWidth, height: window.innerHeight } });
  useLayoutEffect(() => {
    const host = scrollElement.current, element = list.current;
    if (!host || !element) return;
    const measure = () => setMargin(element.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(host); observer?.observe(element);
    return () => observer?.disconnect();
  }, [items.length, error, loading, cancelled, folder, tag, scrollElement]);
  useLayoutEffect(() => { list.current?.style.setProperty("--knowledge-list-height", `${virtual.getTotalSize()}px`); });
  return <>
    <label className={styles.search}><Search size={20} aria-hidden="true" /><input type="search" aria-label="搜索笔记与资料" placeholder="搜索笔记与资料" value={query} onChange={e => onQuery(e.target.value)} /></label>
    <div className={styles.controls}>
      <div className={styles.views} role="tablist" aria-label="笔记视图">{([ ["recent", "最近"], ["common", "常用"], ["all", "全部"] ] as const).map(([id, label]) =>
        <button key={id} role="tab" aria-selected={view === id} className={styles.view} onClick={() => onView(id)}>{label}</button>)}</div>
      <button className={ui.textButton} onClick={onFilter}><SlidersHorizontal size={18} aria-hidden="true" />筛选</button>
    </div>
    {(folder !== "all" || tag) && <div className={styles.filterLabel}><span>已应用{folder !== "all" ? "文件夹" : ""}{tag ? " / 标签" : ""}筛选</span><button className={ui.textButton} onClick={onClear}>清除筛选</button></div>}
    {error && <MobileNotice error title={items.length ? "部分资料未能更新" : "笔记暂时无法读取"} detail={error} action={<button className={ui.textButton} onClick={onRetry}>重新读取</button>} />}
    {loading && <MobileNotice tone="pending" title={items.length ? "正在更新资料…" : "正在读取手机资料…"} action={<button className={ui.textButton} onClick={onCancel}>停止读取</button>} />}
    {cancelled && <MobileNotice title="已停止读取" detail="已取得的资料保留，准备好后可继续。" action={<button className={ui.textButton} onClick={onRetry}>重新读取</button>} />}
    {!loading && !error && !cancelled && items.length === 0 && <div className={styles.empty}>
      <h2>{filtered ? "没有找到匹配笔记" : view === "common" ? "还没有常用资料" : view === "recent" ? "还没有阅读记录" : "这里还没有笔记"}</h2>
      <p>{filtered ? "换一个关键词，或清除当前筛选。" : view === "common" ? "打开笔记，加入手机常用，之后查找更方便。" : "可以先记一条本机笔记，或连接知识库取得资料。"}</p>
      <button className={ui.secondary} onClick={filtered ? onClear : view === "all" ? onNew : () => onView("all")}>{filtered ? "清除关键词与筛选" : view === "all" ? "先记一条" : "查看全部资料"}</button>
    </div>}
    {!!items.length && <>
      <p className={`${styles.meta} ${styles.resultCount}`}>{query ? `手机已有内容 · 已找到${items.length}${hasMore ? "+" : ""}篇` : view === "common" ? "仅此手机的常用资料" : view === "recent" ? "最近在此手机阅读" : "手机已有资料"}</p>
      <ul ref={list} className={styles.notes}>{virtual.getVirtualItems().map(row => { const note = items[row.index]; return <li key={note.id} className={styles.virtualRow} data-index={row.index} ref={element => {
        if (element) { element.style.setProperty("--knowledge-row-top", `${row.start - margin}px`); virtual.measureElement(element); }
      }}>
        <button className={styles.note} data-note-id={note.id} aria-current={selected === note.id ? "true" : undefined} onClick={() => onOpen(note.id)}>
          <strong>{note.title || "未命名笔记"}</strong><p>{note.excerpt || "打开查看正文"}</p><span className={styles.meta}>{note.folder_name || (note.folder_id ? "已分类" : "未分类")} · {relativeTime(note.updated_at)}</span>
        </button>
      </li>; })}</ul>
    </>}
    {hasMore && <button className={`${ui.secondary} ${styles.loadMore}`} disabled={loading} onClick={onMore}>{loading ? "正在读取…" : "加载更多资料"}</button>}
  </>;
}
