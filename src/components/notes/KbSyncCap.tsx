/**
 * KbSyncCap — 知识库同步状态胶囊 + 浮层（方案 A，2026-09）。
 *
 * 替代原先堆在列表上方的全宽 `KbSyncStatusBar`：
 *   · 常态只占面包屑行 26px
 *   · 有 warn/bad 时橙/红点 + 角标
 *   · 点开浮层看全部提示；× = 本次不再提示
 *
 * 数据分级见 `@/hooks/useKbSyncStatus`（与旧状态条同一套规则）。
 */
import { useEffect, useRef, useState } from "react";
import { useKbSyncStatus } from "@/hooks/useKbSyncStatus";
import styles from "./KbSyncCap.module.css";

export function KbSyncCap({
  enabled,
  onSearchConflicts,
  onOpenSettings,
}: {
  enabled: boolean;
  onSearchConflicts: () => void;
  /** 浮层底部「打开同步设置」。可选：没有设置入口时就不渲染该链。 */
  onOpenSettings?: () => void;
}) {
  const snap = useKbSyncStatus(enabled, onSearchConflicts);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!snap.visible) return null;

  const dotClass =
    snap.capTone === "ok"
      ? styles.dotOk
      : snap.capTone === "warn"
        ? styles.dotWarn
        : snap.capTone === "bad"
          ? styles.dotBad
          : "";

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.cap}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${snap.headTitle} · ${snap.headSub}`}
      >
        <span className={`${styles.dot} ${dotClass}`} />
        <span>{snap.capText}</span>
        {snap.actionableCount > 0 && (
          <span
            className={`${styles.badge} ${snap.capTone === "bad" ? styles.badgeBad : ""}`}
            aria-label={`${snap.actionableCount} 项需要处理`}
          >
            {snap.actionableCount}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.pop} role="dialog" aria-label="同步状态">
          <div className={styles.head}>
            <span className={styles.headTitle}>{snap.headTitle}</span>
            <span className={styles.headSub}>{snap.headSub}</span>
          </div>
          <div className={styles.list}>
            {snap.alerts.length === 0 ? (
              <div className={styles.empty}>没有需要处理的提示。</div>
            ) : (
              snap.alerts.map((a) => (
                <div
                  key={a.key}
                  className={
                    a.tone === "warn"
                      ? `${styles.item} ${styles.itemWarn}`
                      : a.tone === "bad"
                        ? `${styles.item} ${styles.itemBad}`
                        : `${styles.item} ${styles.itemInfo}`
                  }
                >
                  <div className={styles.itemTitle}>
                    <span style={{ flex: 1, minWidth: 0 }} title={a.rawError}>
                      {a.title}
                    </span>
                    <button
                      type="button"
                      className={styles.dismiss}
                      onClick={() => snap.dismiss(a.key)}
                      title="本次不再提示"
                      aria-label="本次不再提示"
                    >
                      ×
                    </button>
                  </div>
                  {a.detail && <div className={styles.itemDet}>{a.detail}</div>}
                  {a.action && (
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => {
                        a.action!.run();
                        setOpen(false);
                      }}
                    >
                      {a.action.label}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <div className={styles.foot}>
            <span>× = 本次不再提示</span>
            {onOpenSettings && (
              <button type="button" className={styles.footLink} onClick={onOpenSettings}>
                打开同步设置 →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
