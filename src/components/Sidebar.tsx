import { useState } from "react";
import styles from "./Sidebar.module.css";

/** 侧边栏分组项 */
export interface SidebarGroup {
  id: string;
  name: string;
  count: number;
  icon?: string;   // emoji 图标
  color?: string;  // dot 颜色类名，如 "dot-blue"
  isBuiltin?: boolean; // 内置分组（全部/未分组/收藏）
}

interface SidebarProps {
  open: boolean;
  activeGroupId: string;
  groups: SidebarGroup[];
  onSelectGroup: (id: string) => void;
  onClose: () => void;
}

export function Sidebar({ open, activeGroupId, groups, onSelectGroup, onClose }: SidebarProps) {
  const [listKey] = useState(() => crypto.randomUUID());

  const builtinGroups = groups.filter(g => g.isBuiltin);
  const customGroups = groups.filter(g => !g.isBuiltin);

  return (
    <aside className={`${styles.sidebar}${open ? ` ${styles.open}` : ""}`}>
      <div className={styles.list} key={listKey}>
        {/* 内置分组 — 无 section label，直接显示 */}
        {builtinGroups.map((g) => (
          <button
            key={g.id}
            className={`${styles.item}${activeGroupId === g.id ? ` ${styles.active}` : ""}`}
            onClick={() => onSelectGroup(g.id)}
            tabIndex={open ? 0 : -1}
          >
            {g.icon && <span className={styles.icon}>{g.icon}</span>}
            <span className={styles.name}>{g.name}</span>
            <span className={styles.count}>{g.count}</span>
          </button>
        ))}

        {/* 来源分组 — 带 section label */}
        {customGroups.length > 0 && (
          <>
            <div className={styles.sep} />
            <div className={styles.sectionLabel}>来源</div>
            {customGroups.map((g) => (
              <button
                key={g.id}
                className={`${styles.item}${activeGroupId === g.id ? ` ${styles.active}` : ""}`}
                onClick={() => onSelectGroup(g.id)}
                tabIndex={open ? 0 : -1}
              >
                {g.icon ? <span className={styles.icon}>{g.icon}</span> : g.color ? <span className={`${styles.dot} ${styles[g.color] || ""}`} /> : null}
                <span className={styles.name}>{g.name}</span>
                <span className={styles.count}>{g.count}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <button className={styles.collapseBtn} onClick={onClose} tabIndex={open ? 0 : -1}>
          <svg className={styles.collapseIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 3L6 8l5 5" />
          </svg>
          收起侧边栏
        </button>
      </div>
    </aside>
  );
}
