/**
 * RcSessionHistory — 设置里最近会话元数据（不记画面/键鼠）。
 */
import { useEffect, useState } from "react";
import { rcSessionHistory, type RcHistoryItem } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration, formatWhen } from "@/lib/rcSessionStats";
// D10：历史记录用 rc 会话专用的 hist* 类，不再复用「局域网同步」的 lanDevice* 类
import styles from "./RemoteComputer.module.css";

export function RcSessionHistory() {
  const [list, setList] = useState<RcHistoryItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void rcSessionHistory()
      .then(setList)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className={styles.histNote}>加载中…</div>;
  }
  if (err) {
    return <div className={styles.histNoteErr}>读取会话历史失败：{err}</div>;
  }
  if (list.length === 0) {
    return (
      <div className={styles.histNote}>
        暂无会话记录。开始一次远程后会出现在这里（只记元数据）。
      </div>
    );
  }

  return (
    <div className={styles.histList}>
      {list.map((h, i) => (
        <div key={`${h.started_ms}-${i}`} className={styles.histItem}>
          <div className={styles.histInfo}>
            <div className={styles.histName}>
              {h.peer_name || fingerprintOf(h.peer)}
              <span className={styles.histNameMeta}>
                {h.dir === "outbound" ? "我发起" : "对方控我"} ·{" "}
                {h.capability === "control" ? "可控" : "只看"}
              </span>
            </div>
            <div className={styles.histTime}>
              {formatWhen(h.started_ms)} · {formatDuration(h.duration_ms)} · {h.reason}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
