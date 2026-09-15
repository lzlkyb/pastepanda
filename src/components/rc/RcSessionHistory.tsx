/**
 * RcSessionHistory — 设置里最近会话元数据（不记画面/键鼠）。
 */
import { useEffect, useState } from "react";
import { rcSessionHistory, type RcHistoryItem } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration, formatWhen } from "@/lib/rcSessionStats";
import styles from "../Settings.module.css";

export function RcSessionHistory() {
  const [list, setList] = useState<RcHistoryItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void rcSessionHistory()
      .then(setList)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return (
      <div style={{ fontSize: 12, color: "var(--danger, #d64545)" }}>读取会话历史失败：{err}</div>
    );
  }
  if (list.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
        暂无会话记录。开始一次远程后会出现在这里（只记元数据）。
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {list.map((h, i) => (
        <div key={`${h.started_ms}-${i}`} className={styles.lanDeviceItem}>
          <div className={styles.lanDeviceInfo} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {h.peer_name || fingerprintOf(h.peer)}
              <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                {h.dir === "outbound" ? "我发起" : "对方控我"} ·{" "}
                {h.capability === "control" ? "可控" : "只看"}
              </span>
            </div>
            <div className={styles.lanDeviceTime}>
              {formatWhen(h.started_ms)} · {formatDuration(h.duration_ms)} · {h.reason}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
