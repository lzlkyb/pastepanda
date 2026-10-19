import type { RefObject } from "react";
import { ArrowDown, ArrowUp, Settings2, X } from "lucide-react";
import type { ToolHandlers, ToolItem, ToolKey } from "@/lib/toolbox";
import styles from "../ToolboxView.module.css";

export function ToolboxLaunchpad({ tools, pad, editing, handlers, editRef, onPad, onEdit, onRun, onRemove, onMove }: {
  tools: ToolItem[]; pad: "mine" | "recent"; editing: boolean; handlers: ToolHandlers;
  editRef: RefObject<HTMLButtonElement | null>; onPad: (pad: "mine" | "recent") => void; onEdit: () => void;
  onRun: (tool: ToolItem) => void; onRemove: (key: ToolKey) => void; onMove: (index: number, direction: number) => void;
}) {
  return <section className={styles.launchpad} aria-label="快捷工具">
    <header className={styles.padHeading}>
      {editing ? <h2>编辑我的常用</h2> : <div className={styles.padTabs} role="tablist" aria-label="快捷工具">
        {(["mine", "recent"] as const).map(key => <button type="button" key={key} id={`toolbox-pad-${key}`} role="tab"
          aria-selected={pad === key} aria-controls="toolbox-pad-content" tabIndex={pad === key ? 0 : -1}
          onClick={() => onPad(key)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const next = event.key === "Home" ? "mine" : event.key === "End" ? "recent" : pad === "mine" ? "recent" : "mine";
            onPad(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#toolbox-pad-${next}`)?.focus();
          }}>{key === "mine" ? "我的常用" : "最近使用"}</button>)}
      </div>}
      {!editing && <button type="button" ref={editRef} className={styles.editButton} onClick={onEdit}><Settings2 size={13} />编辑常用</button>}
    </header>
    {editing && <p className={styles.editHint}>从目录添加，最多 6 项；用箭头调整顺序。</p>}
    <div id="toolbox-pad-content" className={styles.favorites} data-count={tools.length}
      role={editing ? "group" : "tabpanel"} aria-label={editing ? "编辑常用工具" : undefined}
      aria-labelledby={editing ? undefined : `toolbox-pad-${pad}`}>
      {tools.length ? tools.map((tool, index) => <div className={styles.favoriteCell} key={tool.key}>
        <button type="button" className={styles.favoriteRun} disabled={editing || !handlers[tool.key]} onClick={() => onRun(tool)}
          title={`${tool.name} · ${tool.desc}${tool.shortcut ? ` · ${tool.shortcut}` : ""}`}>
          <span className={styles.tile} data-hue={tool.hue} aria-hidden="true">{tool.icon}</span>
          <span className={styles.favoriteName}>{tool.name}</span>
        </button>
        {editing && <div className={styles.editActions}>
          <button type="button" aria-label={`前移${tool.name}`} disabled={!index} onClick={() => onMove(index, -1)}><ArrowUp size={14} /></button>
          <button type="button" aria-label={`后移${tool.name}`} disabled={index === tools.length - 1} onClick={() => onMove(index, 1)}><ArrowDown size={14} /></button>
          <button type="button" aria-label={`移除${tool.name}`} onClick={() => onRemove(tool.key)}><X size={13} />移除</button>
        </div>}
      </div>) : <div className={styles.emptyPad}>
        <strong>{pad === "recent" && !editing ? "还没有使用记录" : "把常用工具放到这里"}</strong>
        <p>{pad === "recent" && !editing ? "从下方打开一个工具，下次可以快速找到。" : "在编辑常用中，从目录选择你经常使用的工具。"}</p>
      </div>}
    </div>
  </section>;
}
