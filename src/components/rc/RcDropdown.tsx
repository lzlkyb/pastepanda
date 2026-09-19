/**
 * RcDropdown — 会话底栏用的紧凑下拉（画质 / 画面）。
 *
 * 为什么不用 `<select>`：原生 select 在各平台的弹出层完全不可控（Windows 上是
 * 系统绘制的白底列表，在深色会话条上像弹了个系统对话框），且没法显示 `tip`。
 *
 * 为什么菜单**向上**弹：它长在画面下沿，向下弹会盖住画面外、撞到窗口底边。
 *
 * 关闭时机：点击菜单外任意处（`mousedown` 而非 `click`——用户按下就表示想点别的，
 * 等 click 结束才关会让这一次点击落在被遮挡的元素上）。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./RemoteComputer.module.css";

export function RcDropdown<T extends string>({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  /** 前缀名（画质 / 画面），当前值写在它右边。 */
  label: string;
  value: T;
  options: readonly { key: T; label: string; tip: string }[];
  disabled?: boolean;
  onPick: (k: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.key === value);

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.menuBtn}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label} <b className={styles.menuCur}>{current?.label ?? value}</b>
        <ChevronDown size={12} className={styles.menuCaret} />
      </button>
      {open && (
        <div className={styles.menuPop} role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={o.key === value}
              title={o.tip}
              className={o.key === value ? styles.menuItemOn : styles.menuItem}
              onClick={() => {
                setOpen(false);
                onPick(o.key);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
