import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Braces, ClipboardList, FileText, Monitor, Search, Shapes, X } from "lucide-react";
import { TOOLBOX_GROUPS, filterToolItems, toolsByKeys, type ToolHandlers } from "@/lib/toolbox";
import { primarySearchShortcut, toolShortcutLabel, canAnimateInterface } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useToolboxWorkspace } from "@/hooks/useToolboxWorkspace";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import { ToolboxCard } from "./toolbox/ToolboxCard";
import { ToolboxLaunchpad } from "./toolbox/ToolboxLaunchpad";
import { ToolboxCategories } from "./toolbox/ToolboxCategories";
import { ToolboxRecordings } from "./toolbox/ToolboxRecordings";
import styles from "./ToolboxView.module.css";

const GROUP_ICONS = { ClipboardList, FileText, Braces, Shapes, Monitor };

export function ToolboxView({ handlers }: { handlers: ToolHandlers }) {
  const config = useAppStore(state => state.config);
  const state = useToolboxWorkspace(handlers);
  const mode = useInterfaceMotion();
  const scrollRef = useRef<HTMLDivElement>(null), catalogRef = useRef<HTMLDivElement>(null), padRef = useRef<HTMLDivElement>(null);
  const q = state.query.trim();
  const tools = useMemo(() => TOOLBOX_GROUPS.flatMap(group => group.items).map(tool => ({
    ...tool, shortcut: toolShortcutLabel(tool.key, tool.shortcut, config),
  })), [config]);
  const groups = useMemo(() => TOOLBOX_GROUPS.map(group => ({ ...group,
    items: group.items.filter(tool => !tool.secondaryOnly).map(tool => tools.find(item => item.key === tool.key)!),
  })), [tools]);
  const visible = useMemo(() => groups.filter(group => state.category === "全部" || group.label === state.category)
    .map(group => ({ ...group, items: filterToolItems(group.items, q) })).filter(group => group.items.length), [groups, state.category, q]);
  const matched = visible.reduce((count, group) => count + group.items.length, 0);
  const first = visible.flatMap(group => group.items).find(tool => !!handlers[tool.key]);
  const padTools = toolsByKeys(state.draft ?? (state.pad === "mine" ? state.pins : state.recent)).map(tool => tools.find(item => item.key === tool.key)!);
  const filterKey = `${state.category}|${q}`;
  const previous = useRef(filterKey);
  useLayoutEffect(() => {
    const changed = previous.current !== filterKey;
    previous.current = filterKey;
    if (!changed) return;
    // Keep the chosen category and its new results visible after narrowing a long list.
    const wrapper = scrollRef.current;
    if (wrapper) wrapper.scrollTop = Math.min(wrapper.scrollTop, (padRef.current?.offsetHeight ?? 0) + 8);
    if (mode !== "full" || !canAnimateInterface() || !catalogRef.current?.animate) return;
    const animation = catalogRef.current.animate([
      { opacity: .35, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" },
    ], { duration: 200, easing: "cubic-bezier(0.05,0.7,0.1,1)" });
    return () => animation.cancel();
  }, [filterKey, mode]);

  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation(); if (first) state.run(first);
    } else if (event.key === "Escape" && state.query) {
      event.preventDefault(); event.stopPropagation(); state.setQuery("");
    }
  };
  return <div className={styles.wrap} data-editing={state.editing}>
    <div className={styles.workspace} onKeyDown={event => {
      // Tool buttons own their native activation/navigation; global history commands yield.
      if ((event.target as HTMLElement).closest("button") && ["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) event.stopPropagation();
    }}>
      <header className={styles.toolHead}><h1>工具台</h1>
        <label className={styles.searchField}><Search size={16} /><input type="search" ref={state.searchRef}
          placeholder="搜索名称、用途或快捷键…" aria-label="搜索工具" value={state.query}
          onChange={event => state.setQuery(event.target.value)} onKeyDown={searchKey} /><kbd>{primarySearchShortcut()}</kbd></label>
      </header>
      <main className={styles.scroll} ref={scrollRef}>
        {(!q || state.editing) && <div ref={padRef}><ToolboxLaunchpad tools={padTools} pad={state.pad} editing={state.editing}
          handlers={handlers} editRef={state.editRef} onPad={state.setPad} onEdit={state.begin} onRun={state.run}
          onRemove={state.togglePin} onMove={state.move} /></div>}
        <ToolboxCategories groups={groups} category={state.category} onChange={state.setCategory} />
        <div className={styles.catalogLabel}><span>{q ? "搜索结果 · " : ""}{state.category === "全部" ? "全部工具" : state.category}</span><span>{matched} 个入口</span></div>
        <div className={styles.catalog} ref={catalogRef} id="toolbox-catalog" role="tabpanel"
          aria-labelledby={`toolbox-category-${["全部", ...groups.map(group => group.label)].indexOf(state.category)}`}>
          {visible.map(group => {
            const Icon = GROUP_ICONS[group.icon as keyof typeof GROUP_ICONS] ?? FileText;
            return <section className={styles.group} key={group.label}>
              <header className={styles.groupHead}><Icon size={16} /><h2>{group.label}</h2><small>{group.items.length} 项</small></header>
              <div className={styles.grid}>{group.items.map(tool => {
                const secondary = tools.find(item => item.key === tool.secondaryKey);
                return <ToolboxCard key={tool.key} tool={tool} secondary={secondary} enabled={!!handlers[tool.key]}
                  secondaryEnabled={!!secondary && !!handlers[secondary.key]} editing={state.editing}
                  pinned={!!state.draft?.includes(tool.key)} onRun={() => state.run(tool)}
                  onSecondary={() => { if (secondary) state.run(secondary); }} onPin={() => state.togglePin(tool.key)} />;
              })}</div>
            </section>;
          })}
          {!matched && <div className={styles.empty}><Search size={28} /><h2>没有匹配的工具</h2><p>试试名称或用途，或者返回全部工具。</p>
            <button type="button" onClick={() => { state.setQuery(""); state.setCategory("全部"); state.searchRef.current?.focus(); }}>清除筛选</button></div>}
        </div>
        {!q && !state.editing && ["全部", "图形与录屏"].includes(state.category) && <ToolboxRecordings key={state.category} expanded={state.category === "图形与录屏"} />}
      </main>
      {state.editing && <footer className={styles.editBar}>
        <div>{state.error ? <p role="alert">{state.error}</p> : <span role="status">已固定 {state.draft?.length} / 6 项</span>}</div>
        <button type="button" onClick={state.cancel}>取消</button><button type="button" className={styles.saveButton} onClick={state.save}>保存常用</button>
      </footer>}
      {state.notice && <div className={styles.notice} role="status"><span>{state.notice}</span><button type="button" aria-label="关闭提示" onClick={() => state.setNotice("")}><X size={14} /></button></div>}
    </div>
  </div>;
}
