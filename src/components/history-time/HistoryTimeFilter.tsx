import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useClick, useDismiss, useFloating, useInteractions, useRole, useTransitionStatus } from "@floating-ui/react";
import { ChevronDown, Clock, RefreshCw, X } from "lucide-react";
import { useAppStore, type TimeFilter } from "@/stores/appStore";
import { canAnimateInterface, cleanSourceName, historyDateOffset, historyLocalDate, historyTimeLabel, historyTimeWindow, parseHistoryWindow } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { isDarkTheme } from "@/lib/theme";
import { useHistoryTimeDistribution } from "@/hooks/useHistoryTimeDistribution";
import { HistoryDays } from "./TimeDistributionCharts";
import { HistoryTimeDetails } from "./HistoryTimeDetails";
import { HistoryTimeSummary } from "./HistoryTimeSummary";
import styles from "./HistoryTime.module.css";

export function HistoryTimeFilter() {
  const value = useAppStore(s => s.timeFilter);
  const setTime = useAppStore(s => s.setTimeFilter);
  const keyword = useAppStore(s => s.searchKeyword);
  const type = useAppStore(s => s.filterType);
  const source = useAppStore(s => s.sourceFilter);
  const theme = useAppStore(s => s.config.theme);
  const [open, setOpen] = useState(false);
  const today = historyLocalDate(new Date());
  const chartStart = historyDateOffset(today, -13);
  const [day, setDay] = useState(() => parseHistoryWindow(value)?.start.slice(0, 10) ?? today);
  const [previewDay, setPreviewDay] = useState<string | null>(null);
  const titleId = useId();
  const stats = useHistoryTimeDistribution(open, day);
  const range = parseHistoryWindow(value);
  const rangeDay = range?.start.slice(0, 10);
  const hasDistribution = !!stats.data;
  useEffect(() => { if (rangeDay) setDay(rangeDay); setPreviewDay(null); }, [rangeDay, value]);
  useEffect(() => { if (!open || !hasDistribution) setPreviewDay(null); }, [open, hasDistribution]);
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open, onOpenChange: setOpen, strategy: "fixed", placement: "bottom-end",
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 }), size({ padding: 12,
      apply: ({ availableHeight, elements }) => { elements.floating.style.setProperty("--time-available-height", `${Math.max(100, availableHeight)}px`); },
    })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context), useDismiss(context), useRole(context, { role: "dialog" }),
  ]);
  const animate = canAnimateInterface();
  // Keep the surface mounted for its exit, but stop queries and interaction on close.
  const { isMounted, status } = useTransitionStatus(context, { duration: animate ? MOTION.fast * 1000 : 0 });
  // Both the open trigger and portal own their keys; otherwise Delete/Enter can
  // act on a selected card behind the panel. Escape 同样拦下并自己关面板：
  // useDismiss 的元素级 stopPropagation 是主要防线，这里是双保险——面板开着
  // 但焦点落在面板外时 Esc 直接进 document，App 全局链会落到 hide_window；
  // 面板内路径也不依赖 useDismiss 的实现细节。
  const containKeys = (event: KeyboardEvent) => {
    if (!open) return;
    event.stopPropagation();
    if (event.key === "Escape") setOpen(false);
  };
  const choose = (date: string) => { setPreviewDay(null); setDay(date); setTime(historyTimeWindow(date)); };
  const chooseHours = (date: string, start: number, end: number) => {
    const next = historyTimeWindow(date, start, end);
    setPreviewDay(null); setDay(date);
    setTime(value === next ? historyTimeWindow(date) : next);
  };
  const now = new Date();
  const monday = historyDateOffset(today, -((now.getDay() + 6) % 7));
  const quick: { label: string; value: TimeFilter }[] = [
    { label: "全部时间", value: "all" }, { label: "今天", value: historyTimeWindow(today) },
    { label: "昨天", value: historyTimeWindow(historyDateOffset(today, -1)) },
    { label: "本周", value: historyTimeWindow(monday, 0, 7 * 24) },
  ];
  const scope = [keyword && `“${keyword}”`, type !== "all" && ({ text: "文本", image: "图片", file: "文件", pinned: "收藏" }[type] ?? type), source && cleanSourceName(source)].filter(Boolean).join(" · ");
  const chartDay = previewDay ?? day;
  const chartCount = stats.data?.days.find(d => d.date === chartDay)?.count;
  const noResults = !stats.loading && !stats.error && stats.selectionCount === 0;
  const dayWindow = parseHistoryWindow(historyTimeWindow(day))!;
  const canExpandDay = !!range && range.start >= dayWindow.start && range.end <= dayWindow.end && value !== historyTimeWindow(day);
  const expandTime = noResults && value !== "all";
  const resultAction = expandTime ? canExpandDay ? "查看全天" : "查看全部时间" : noResults ? "查看记录" : !stats.loading && !stats.error && stats.selectionCount !== null ? `查看 ${stats.selectionCount.toLocaleString()} 条记录` : "查看记录";
  const viewResults = () => {
    if (expandTime) setTime(canExpandDay ? historyTimeWindow(day) : "all");
    else setOpen(false);
  };
  return <>
    <button type="button" ref={refs.setReference} {...getReferenceProps({ onKeyDown: containKeys })} className={`${styles.trigger} ${value !== "all" ? styles.selected : ""}`} title={value === "all" ? "按日期或时段查找记录" : historyTimeLabel(value)}>
      <Clock size={14} /><span>{value === "all" ? "时间" : historyTimeLabel(value)}</span><ChevronDown size={12} className={styles.chevron} />
    </button>
    {isMounted && <FloatingPortal><FloatingFocusManager context={context} modal={false} initialFocus={-1}>
      {/* Floating UI owns runtime geometry; visual styles stay in the CSS module. */}
      <div ref={refs.setFloating} {...getFloatingProps({ onKeyDown: containKeys })} aria-labelledby={titleId} style={floatingStyles} inert={!open}
        data-placement={context.placement} className={`${styles.floating} ${!isPositioned ? styles.positioning : ""}`}>
        {/* Separate animation from Floating UI's positioning transform. */}
        <div className={styles.panel} data-state={status} data-motion={animate ? "full" : "off"} data-color-scheme={isDarkTheme(theme) ? "dark" : "light"}>
        <div className={styles.overview}>
          <header className={styles.heading}><div><h2 id={titleId}><Clock size={20} />按时间找回</h2><p>{scope ? `当前条件：${scope}` : "按当前筛选条件统计"}</p></div><div className={styles.headerActions}><button type="button" className={styles.refreshButton} disabled={stats.loading} onClick={stats.refresh}><RefreshCw size={12} />重新读取</button><button type="button" className={styles.iconButton} aria-label="收起时间面板" onClick={() => setOpen(false)}><X size={16} /></button></div></header>
          <HistoryTimeSummary value={value} count={stats.selectionCount} loading={stats.loading} error={stats.error} />
        </div>
        <div className={styles.quick}>{quick.map(item => <button type="button" key={item.label} aria-pressed={item.value === value} onClick={() => setTime(item.value)}>{item.label}</button>)}</div>
        {(stats.loading || stats.error) && <div className={styles.fetchStatus} role="status">{stats.loading ? "正在读取时间分布…" : stats.error}</div>}
        {!stats.data && stats.loading ? <div className={styles.skeleton} aria-label="正在加载分布"><div /><div /><div /></div>
          : stats.data && <>
            <div className={styles.dateSection}><div className={styles.sectionHeading}><b>最近 14 天</b><small>{chartStart.slice(0, 7) === today.slice(0, 7) ? `${today.slice(0, 7).replace("-", " 年 ")} 月` : `${chartStart} 至 ${today}`}</small></div>
              {/* An older selected date belongs to the detail section, not a fifteenth chart column. */}
              <HistoryDays days={stats.data.days.filter(d => d.date >= chartStart && d.date <= today)} selectedDate={day} selected={!!range} previewDate={previewDay} onPreview={date => setPreviewDay(date === day ? null : date)} onChoose={choose} />
              <div className={styles.chartCaption}><strong>{previewDay ? "预览：" : ""}{historyTimeLabel(historyTimeWindow(chartDay))}{chartCount === undefined ? "" : ` · ${chartCount} 条`}</strong><span>悬停预览 · 单击筛选</span></div>
              <label className={styles.datePicker}>其他日期<input type="date" value={day} max={today} onChange={e => { if (e.target.value && e.target.validity.valid) choose(e.target.value); }} /></label>
            </div>
            <HistoryTimeDetails open={open} day={day} previewDay={previewDay} value={value} stats={stats} onChoose={chooseHours} />
          </>}
        {!stats.data && !stats.loading && <div className={styles.empty}><Clock size={24} /><p>{stats.error ? "分布未读取成功，不代表记录为空。" : "展开后按需读取时间分布。"}</p></div>}
        <footer className={styles.footer}><span>{stats.loading ? "正在更新数量，筛选已保留" : stats.error ? "数量未读取成功，列表仍可查看" : noResults ? expandTime ? "当前范围没有匹配记录，试试扩大范围" : "没有匹配记录，可调整搜索或类型" : stats.selectionCount !== null ? "筛选已生效 · 收起后查看" : "已保留筛选，正在更新数量"}</span><button type="button" className={styles.primary} onClick={viewResults}>{resultAction}</button></footer>
        </div>
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}
