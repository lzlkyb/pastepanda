import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useClick, useDismiss, useFloating, useInteractions, useRole, useTransitionStatus } from "@floating-ui/react";
import { Check, ChevronDown, Layers, RefreshCw, Search, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useHistorySourceDistribution } from "@/hooks/useHistorySourceDistribution";
import { cleanSourceName } from "@/lib/source-mappings";
import { canAnimateInterface, historyTimeLabel } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { SourceIdentity } from "./SourceIdentity";
import { SourceDetails } from "./SourceDetails";
import { SourceDistributionList } from "./SourceDistributionList";
import styles from "./HistorySource.module.css";

export function HistorySourceFilter() {
  const value = useAppStore(s => s.sourceFilter);
  const setSource = useAppStore(s => s.setSourceFilter);
  const time = useAppStore(s => s.timeFilter);
  const setTime = useAppStore(s => s.setTimeFilter);
  const keyword = useAppStore(s => s.searchKeyword);
  const type = useAppStore(s => s.filterType);
  const workspace = useAppStore(s => s.config.current_workspace);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const titleId = useId();
  const stats = useHistorySourceDistribution(open);
  const changeOpen = (next: boolean) => { setOpen(next); setPreview(null); setQuery(""); };
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open, onOpenChange: changeOpen, strategy: "fixed", placement: "bottom-end",
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 }), size({ padding: 12,
      apply: ({ availableHeight, elements }) => { elements.floating.style.setProperty("--source-available-height", `${Math.max(100, availableHeight)}px`); },
    })], whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context), useDismiss(context), useRole(context, { role: "dialog" }),
  ]);
  const animate = canAnimateInterface();
  const { isMounted, status } = useTransitionStatus(context, { duration: animate ? MOTION.fast * 1000 : 0 });
  const containKeys = (event: KeyboardEvent) => { if (open && event.key !== "Escape") event.stopPropagation(); };
  const choose = (source: string) => { setSource(source); changeOpen(false); };
  const sources = stats.data?.sources;
  useEffect(() => { setPreview(null); }, [stats.data, value]);
  const matching = useMemo(() => sources?.filter(entry => !query.trim() || `${cleanSourceName(entry.source)} ${entry.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [], [sources, query]);
  const selected = sources?.find(s => s.source === value);
  // Preview is local to this surface. The selected filter and main query only change on click.
  const previewEntry = sources?.find(s => s.source === preview);
  const detailEntry = previewEntry ?? selected;
  const metrics = value ? selected : stats.data?.total;
  const detailMetrics = detailEntry ?? (value ? metrics : stats.data?.total);
  const count = !stats.loading && !stats.error && stats.data ? metrics?.count ?? 0 : null;
  const ready = !!stats.data && !stats.loading && !stats.error;
  const unknownCount = stats.data ? stats.data.total.count - stats.data.sources.reduce((n, s) => n + s.count, 0) : 0;
  const scope = [historyTimeLabel(time), keyword && `“${keyword}”`, type !== "all" && ({ text: "文本", image: "图片", file: "文件", pinned: "收藏" }[type] ?? type), workspace].filter(Boolean).join(" · ");
  return <>
    <button type="button" ref={refs.setReference} {...getReferenceProps({ onKeyDown: containKeys })} className={`${styles.trigger} ${value ? styles.selected : ""}`} title={value || "按来源查找记录"}>
      {value ? <SourceIdentity source={value} sourceIcon={selected?.source_icon} /> : <span>全部来源</span>}<ChevronDown size={12} className={styles.chevron} />
    </button>
    {isMounted && <FloatingPortal><FloatingFocusManager context={context} modal={false} initialFocus={-1}>
      {/* Runtime geometry is owned by Floating UI; appearance stays in CSS. */}
      <div ref={refs.setFloating} {...getFloatingProps({ onKeyDown: containKeys })} style={floatingStyles} aria-labelledby={titleId} inert={!open}
        data-placement={context.placement} className={`${styles.floating} ${!isPositioned ? styles.positioning : ""}`}>
        <div className={styles.panel} data-state={status} data-motion={animate ? "full" : "off"}>
          <div className={styles.overview}><header className={styles.heading}><div><h2 id={titleId}><Layers size={20} />按来源找回</h2><p>{scope}</p></div>
            <div className={styles.headerActions}><button type="button" className={styles.refresh} disabled={stats.loading} onClick={() => { setPreview(null); stats.refresh(); }}><RefreshCw size={12} />刷新</button><button type="button" className={styles.iconButton} aria-label="收起来源面板" onClick={() => changeOpen(false)}><X size={16} /></button></div></header>
            <div className={styles.summary}><div><h3>{value ? <SourceIdentity source={value} sourceIcon={selected?.source_icon} /> : "全部来源"}</h3><p>{value ? "已选来源 · 仍可切换到其他应用" : "当前范围的来源分布"}</p></div><div className={styles.resultNumber}><small>找到记录</small><strong>{count === null ? "—" : count.toLocaleString()}</strong><span>条</span></div></div>
          </div>
          <div className={styles.body}>
            {ready && stats.data && stats.data.total.count > 0 ? <>
              <div className={styles.tools}><label className={styles.search}><Search size={14} /><input aria-label="搜索来源应用" placeholder="搜索来源应用…" value={query} onChange={e => { setQuery(e.target.value); setPreview(null); }} />{query && <button type="button" className={styles.iconButton} aria-label="清除来源搜索" onClick={() => { setQuery(""); setPreview(null); }}><X size={14} /></button>}</label>
                <button type="button" className={styles.allSources} aria-pressed={!value} onClick={() => choose("")}><Layers size={16} /><span>全部来源</span><span className={styles.allCount}>{stats.data.total.count.toLocaleString()} 条</span><Check size={14} visibility={!value ? "visible" : "hidden"} /></button>
              </div>
              <SourceDistributionList sources={matching} value={value} query={query} preview={previewEntry?.source ?? null} onPreview={setPreview} onChoose={choose} onClearQuery={() => setQuery("")} />
              {value && !selected && <p className={styles.notice}>该来源在当前范围没有匹配记录，可切换来源或清除来源。</p>}
              {detailMetrics ? <SourceDetails entry={detailEntry} metrics={detailMetrics} total={stats.data.total.count} preview={!!previewEntry} /> : null}
              {unknownCount > 0 && <p className={styles.notice}>总数含 {unknownCount.toLocaleString()} 条未记录来源的内容。</p>}
            </> : <div className={styles.state} role="status">{stats.loading ? <><p>正在读取来源分布…</p><div className={styles.skeleton}><div /><div /><div /></div></> : stats.error ? <><h3>来源分布读取失败</h3><p>{stats.error}</p><button type="button" className={styles.textButton} onClick={stats.refresh}>重新读取</button></> : <><h3>当前范围没有记录</h3><p>试试扩大时间范围，或调整关键词与类型。</p>{time !== "all" && <button type="button" className={styles.textButton} onClick={() => setTime("all")}>查看全部时间</button>}</>}</div>}
          </div>
          <footer className={styles.footer}><span>{stats.loading ? "正在读取来源统计…" : stats.error ? "当前筛选和记录列表已保留" : "悬停预览 · 单击筛选"}</span><button type="button" className={styles.textButton} disabled={!value} onClick={() => choose("")}>清除来源</button></footer>
        </div>
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}
