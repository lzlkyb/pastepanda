import { useEffect, useId, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cleanSourceName } from "@/lib/source-mappings";
import type { HistorySourceEntry } from "@/lib/api/historySource";
import { SourceIdentity } from "./SourceIdentity";
import styles from "./HistorySource.module.css";

export function SourceDistributionList({ sources, value, query, preview, onPreview, onChoose, onClearQuery }: {
  sources: HistorySourceEntry[]; value: string; query: string; preview: string | null;
  onPreview: (source: string | null) => void; onChoose: (source: string) => void; onClearQuery: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewMode = useRef<"pointer" | "keyboard">("pointer");
  const gradientId = useId().replace(/:/g, "");
  const virtual = useVirtualizer({ count: sources.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 42, overscan: 4, initialRect: { width: 372, height: 252 },
    getItemKey: index => sources[index].source,
  });
  useEffect(() => { virtual.scrollToOffset(0); }, [query, virtual]);
  const max = useMemo(() => sources.reduce((max, s) => Math.max(max, s.count), 1), [sources]);
  return <div className={styles.distribution}>
    <div className={styles.sectionHeading}><b>来源分布 · {sources.length} 个应用</b><span>按记录数排序 · 条</span></div>
    <div ref={scrollRef} className={styles.sourceList} aria-label="来源记录数量" onPointerLeave={() => { if (previewMode.current === "pointer") onPreview(null); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onPreview(null); }}>
      <svg className={styles.defs} aria-hidden="true"><defs><linearGradient id={gradientId}><stop className={styles.barStart} /><stop offset="1" className={styles.barEnd} /></linearGradient></defs></svg>
      {/* Virtualizer owns these runtime dimensions, just as Floating UI owns panel geometry. */}
      {sources.length ? <div className={styles.virtualList} ref={element => { if (element) element.style.height = `${virtual.getTotalSize()}px`; }}>
        {virtual.getVirtualItems().map(item => {
          const entry = sources[item.index];
          return <button type="button" key={entry.source} className={styles.sourceRow} ref={element => { if (element) element.style.transform = `translateY(${item.start}px)`; }}
            aria-label={`${cleanSourceName(entry.source)}，${entry.count} 条记录`} title={entry.source}
            aria-pressed={entry.source === value} data-preview={entry.source === preview}
            onPointerEnter={event => { if (event.pointerType !== "touch") { previewMode.current = "pointer"; onPreview(entry.source); } }}
            onFocus={() => { previewMode.current = "keyboard"; onPreview(entry.source); }} onClick={() => onChoose(entry.source)}>
            <SourceIdentity source={entry.source} sourceIcon={entry.source_icon} />
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" className={styles.sourceBar} aria-hidden="true">
              <rect className={styles.barTrack} width="100" height="8" rx="4" />
              <rect className={styles.barValue} width={entry.count / max * 100} height="8" rx="4" fill={entry.source === value ? `url(#${gradientId})` : undefined} />
            </svg><span className={styles.count}>{entry.count.toLocaleString()}</span>
            <Check size={14} className={styles.check} aria-hidden="true" visibility={entry.source === value ? "visible" : "hidden"} />
          </button>;
        })}
      </div> : <div className={styles.searchEmpty}><span>{query ? "没有匹配的来源应用" : "当前范围的记录未记录来源"}</span>
        {query && <button type="button" className={styles.textButton} onClick={onClearQuery}>清除应用名称搜索</button>}</div>}
    </div>
  </div>;
}
