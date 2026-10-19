import type { KeyboardEvent } from "react";
import type { FilterType } from "@/stores/appStore";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import styles from "../TopBar.module.css";

export const HISTORY_TYPE_TABS: { key: FilterType; label: string; icon: string }[] = [
  { key: "all",    label: "全部", icon: "📋" },
  { key: "text",   label: "文本", icon: "📝" },
  // 「图片」同时包含纯图片与图文混排（两者都是带图内容）。
  // 图文不单独占一个标签页：480px 默认窗宽下 6 个标签已经拥挤，
  // 只看图文时用「图文」自动标签精确筛。
  { key: "image",  label: "图片", icon: "📸" },
  { key: "file",   label: "文件", icon: "📁" },
  { key: "pinned", label: "收藏", icon: "⭐" },
];

// Buttons retain their native activation, while global history paste/preview yields.
function containActivation(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

/* ===== 方案 B：iOS 分段控件 ===== */
export function SegmentedTabs({ filterType, setFilterType, counts }: {
  filterType: FilterType; setFilterType: (f: FilterType) => void; counts: Record<string, number> | null;
}) {
  const getCount = (key: string) => (counts ? counts[key] : undefined);
  const mode = useInterfaceMotion();
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    containActivation(event);
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
    if (!button) return;
    let index = HISTORY_TYPE_TABS.findIndex(tab => tab.key === button.dataset.filter);
    if (event.key === "ArrowRight") index = (index + 1) % HISTORY_TYPE_TABS.length;
    else if (event.key === "ArrowLeft") index = (index + HISTORY_TYPE_TABS.length - 1) % HISTORY_TYPE_TABS.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = HISTORY_TYPE_TABS.length - 1;
    else return;
    event.preventDefault(); event.stopPropagation();
    const key = HISTORY_TYPE_TABS[index].key;
    if (key !== filterType) setFilterType(key);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-filter="${key}"]`)?.focus();
  };
  return (
    <div className={styles.segmented} role="tablist" aria-label="内容类型" data-active={filterType} data-motion={mode} onKeyDown={keyboard}>
      <span className={styles.segActiveIndicator} aria-hidden="true" />
      {HISTORY_TYPE_TABS.map((tab) => {
        const active = filterType === tab.key;
        const count = getCount(tab.key);
        return (
          <button key={tab.key} type="button" role="tab" id={`history-type-${tab.key}`} data-filter={tab.key}
            aria-controls="history-type-panel" aria-selected={active} tabIndex={active ? 0 : -1}
            onClick={() => { if (!active) setFilterType(tab.key); }}
            className={`${styles.segItem}${active ? ` ${styles.segItemActive}` : ""}`}
            >
            <span className={styles.segIcon}>{tab.icon}</span>
            <span>{tab.label}</span>
            {count !== undefined && <span className={styles.segCount}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ===== 方案 C：圆形图标 Tab ===== */
export function CircleTabs({ filterType, setFilterType, counts }: {
  filterType: FilterType; setFilterType: (f: FilterType) => void; counts: Record<string, number> | null;
}) {
  const getCount = (key: string) => (counts ? counts[key] : undefined);
  return (
    <div className={styles.tabsCircle} onKeyDown={containActivation}>
      {HISTORY_TYPE_TABS.map((tab) => {
        const active = filterType === tab.key;
        const count = getCount(tab.key);
        return (
          <button key={tab.key} type="button" onClick={() => { if (!active) setFilterType(tab.key); }}
            id={`history-type-${tab.key}`} aria-pressed={active}
            className={`${styles.circleTab}${active ? ` ${styles.circleTabActive}` : ""}`}>
            <div className={styles.circleIcon}>
              <span>{tab.icon}</span>
            </div>
            <span className={styles.circleLabel}>{tab.label}</span>
            {count !== undefined && count > 0 && <span className={styles.circleBadge}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
