/**
 * RcSettingsView — 设置页签真身：会话历史（只读）+ 远程通道开关 + 触摸演示。
 *
 * 历史数据与文案来自共享层（`useRcHistory` / `formatWhen` / `formatDuration`），
 * 与桌面工作台「会话记录」同一份判据；手机端只读 + 清空，不做筛选。
 *
 * 「恢复每次询问」不放这里：自动接受是**每台设备**的策略（对端表字段），
 * 语义归属设备，而手机端只当发起端、不被连——设备策略在电脑端设置页管。
 */
import { useState } from "react";
import { formatDuration, formatWhen } from "@/lib/rcSessionStats";
import { useRcHistory } from "@/hooks/useRcHistory";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RcSettings.module.css";

const CAP_LABEL: Record<string, string> = {
  control: "远程控制",
  view: "只看画面",
};

function dirLabel(dir: "inbound" | "outbound"): string {
  return dir === "outbound" ? "连到" : "被连";
}

export function RcSettingsView({
  rc,
  onOpenSandbox,
}: {
  rc: UseRc;
  onOpenSandbox: () => void;
}) {
  const history = useRcHistory();
  const [confirmClear, setConfirmClear] = useState(false);
  const enabled = rc.status?.enabled ?? null;

  const clearHistory = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await rc.clearHistory();
    setConfirmClear(false);
    void history.reload();
  };

  return (
    <div className={styles.root}>
      {/* 远程通道：关掉后既不能发起也不能被连（省电/彻底断开用） */}
      <section className={styles.card}>
        <div className={styles.cardTitle}>远程通道</div>
        <div className={styles.cardRow}>
          <span className={styles.rowText}>
            {enabled === null ? "状态未知" : enabled ? "已开启（可发起 / 可被连）" : "已关闭"}
          </span>
          {enabled !== null && (
            <button
              type="button"
              className={`${styles.toggleBtn} ${enabled ? styles.toggleOn : ""}`}
              disabled={rc.busy}
              onClick={() => void rc.setEnabled(!enabled)}
            >
              {enabled ? "关闭" : "开启"}
            </button>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          会话历史
          {history.list.length > 0 && (
            <button type="button" className={styles.clearBtn} onClick={() => void clearHistory()}>
              {confirmClear ? "再点一次确认清空" : "清空"}
            </button>
          )}
        </div>
        {history.loading ? (
          <div className={styles.hint}>正在获取…</div>
        ) : history.err ? (
          <div className={styles.hintErr} role="alert">
            {history.err}
            <button type="button" className={styles.clearBtn} onClick={() => void history.reload()}>
              重试
            </button>
          </div>
        ) : history.list.length === 0 ? (
          <div className={styles.hint}>还没有会话记录</div>
        ) : (
          <ul className={styles.histList} aria-label="会话历史">
            {history.list.map((h, i) => (
              <li key={`${h.started_ms}-${i}`} className={styles.histItem}>
                <div className={styles.histTop}>
                  <span className={styles.histName}>
                    {dirLabel(h.dir)} {h.display_name || h.peer_name}
                  </span>
                  <span className={styles.histDur}>{formatDuration(h.duration_ms)}</span>
                </div>
                <div className={styles.histSub}>
                  {CAP_LABEL[h.capability] ?? h.capability} · {formatWhen(h.started_ms)}
                  {h.reason ? ` · ${h.reason}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>联调</div>
        <button type="button" className={styles.sandboxBtn} onClick={onOpenSandbox}>
          触摸演示（无远端 · 联调手势层）
        </button>
      </section>
    </div>
  );
}
