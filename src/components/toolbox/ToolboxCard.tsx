import type { ToolItem } from "@/lib/toolbox";
import styles from "../ToolboxView.module.css";

export function ToolboxCard({ tool, secondary, enabled, secondaryEnabled, editing, pinned, onRun, onSecondary, onPin }: {
  tool: ToolItem; secondary?: ToolItem; enabled: boolean; secondaryEnabled: boolean;
  editing: boolean; pinned: boolean; onRun: () => void; onSecondary: () => void; onPin: () => void;
}) {
  return <article className={styles.item} data-secondary={!!secondary && !editing} data-unavailable={!enabled}>
    <button type="button" className={styles.toolMain} disabled={!enabled || editing} onClick={onRun}
      title={`${tool.name} · ${tool.desc}${tool.shortcut ? ` · ${tool.shortcut}` : ""}`}>
      <span className={styles.tile} data-hue={tool.hue} aria-hidden="true">{tool.icon}</span>
      <span className={styles.toolCopy}><span className={styles.nameRow}><strong>{tool.name}</strong>
        {tool.shortcut && <kbd>{tool.shortcut}</kbd>}</span><span className={styles.desc}>{tool.desc}</span>
        {!enabled && <span className={styles.unavailable}>当前环境不可用</span>}
      </span>
    </button>
    {secondary && !editing && <button type="button" className={styles.secondary} aria-label={secondary.name}
      title={secondary.desc} disabled={!secondaryEnabled} onClick={onSecondary}>
      <span aria-hidden="true">{secondary.icon}</span>全屏</button>}
    {editing && <button type="button" className={styles.pinToggle} aria-label={`${pinned ? "移除常用" : "固定"}${tool.name}`} aria-pressed={pinned} onClick={onPin}>
      {pinned ? "✓ 已固定 · 点击移除" : "+ 添加到常用"}</button>}
  </article>;
}
