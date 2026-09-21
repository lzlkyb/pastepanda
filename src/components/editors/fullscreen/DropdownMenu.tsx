/**
 * 全屏编辑器通用小型下拉菜单（稿子 P0-4 ⋯ 菜单 / P0-5 格式栏菜单共用）。
 *
 * 设计约束：
 * - 触发器由调用方给（⋯ 图标按钮 / 「标题 ▾」文字按钮），本组件只管
 *   「开合 + 浮层 + 外点关闭 + Esc 关闭 + 选中后关闭」这套浮层行为；
 * - 浮层卡用 `--float-card-*` 令牌（不透明、带边框阴影，规则 8.3 不用玻璃）；
 * - 快捷键以 kbd 常驻（L5），由条目自带的 `kbd` 字段渲染；
 * - `"sep"` 条目渲染分隔线，用于菜单内部分组（对齐稿子 ⋯ 菜单的三段式）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "../FullscreenEditor.module.css";

/** 菜单条目；`"sep"` 表示一条分隔线 */
export type MenuEntry =
  | {
      key: string;
      label: ReactNode;
      icon?: ReactNode;
      /** 常驻快捷键提示（kbd） */
      kbd?: string;
      /** 置灰但仍占位（与「不适用就不出现」不冲突：那是整条不渲染，这是条件性禁用） */
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
    }
  | "sep";

interface DropdownMenuProps {
  /** 触发器内容（不是完整 button，本组件包一层 button 以统一开合行为） */
  trigger: ReactNode;
  /** 触发器按钮的 class（调用方给样式，如 tbBtn / fmtBtnText） */
  triggerClassName: string;
  /** 触发器 title（可访问性 + 悬停提示） */
  triggerTitle: string;
  /** 触发器激活态（菜单打开时高亮） */
  triggerActive?: boolean;
  entries: MenuEntry[];
  /** 浮层对齐：right = 右缘对齐触发器（工具栏 ⋯ 用），left = 左缘对齐（格式栏用） */
  align?: "left" | "right";
  /** 浮层附加 class（格式栏菜单略窄时用） */
  menuClassName?: string;
}

export function DropdownMenu({
  trigger,
  triggerClassName,
  triggerTitle,
  triggerActive = false,
  entries,
  align = "right",
  menuClassName,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外点关闭 + Esc 关闭。仅 open 时挂监听，避免每颗菜单常驻 document 监听。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.menuAnchor} ref={rootRef}>
      <button
        type="button"
        className={`${triggerClassName} ${triggerActive || open ? styles.menuTriggerActive : ""}`}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`${styles.menuPop} ${align === "left" ? styles.menuPopLeft : ""} ${menuClassName ?? ""}`}
        >
          {entries.map((entry) =>
            entry === "sep" ? (
              <div key={`sep-${entries.indexOf(entry)}`} className={styles.menuSep} />
            ) : (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                disabled={entry.disabled}
                title={entry.title}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
              >
                {entry.icon && <span className={styles.menuItemIcon}>{entry.icon}</span>}
                <span className={styles.menuItemLabel}>{entry.label}</span>
                {entry.kbd && <kbd className={styles.menuItemKbd}>{entry.kbd}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
