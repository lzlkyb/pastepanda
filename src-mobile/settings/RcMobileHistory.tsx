import { useRef, useState } from "react";
import { useRcHistory } from "@/hooks/useRcHistory";
import type { UseRc } from "@/hooks/useRc";
import { formatDuration, formatWhen } from "@/lib/rcSessionStats";
import { MobileNotice } from "../ui/MobileNotice";
import { rcErrorText } from "../devices/rcErrorText";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcSettings.module.css";

export function RcMobileHistory({ rc }: { rc: UseRc }) {
  const history = useRcHistory();
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const locked = useRef(false);
  const clear = async () => {
    if (locked.current) return;
    locked.current = true;
    setClearing(true);
    try {
      if (await rc.clearHistory()) {
        setConfirm(false);
        await history.reload();
      }
    } finally {
      locked.current = false;
      setClearing(false);
    }
  };
  return (
    <>
      {rc.error && <MobileNotice error title="历史记录操作未能完成" detail={rcErrorText(rc.error)} onDismiss={rc.clearError} />}
      {history.loading ? (
        <p className={ui.empty}>正在获取…</p>
      ) : history.err ? (
        <MobileNotice
          error
          title="会话历史未能加载"
          detail={rcErrorText(history.err)}
          action={
            <button type="button" className={ui.textButton} onClick={() => void history.reload()}>
              重试
            </button>
          }
        />
      ) : history.list.length === 0 ? (
        <p className={ui.empty}>还没有会话记录</p>
      ) : (
        <>
          <ul className={styles.histList} aria-label="会话历史">
            {history.list.map((h, i) => (
              <li key={`${h.started_ms}-${i}`}>
                <div className={styles.histTop}>
                  <strong>
                    {h.dir === "outbound" ? "连到" : "被连"} {h.display_name || h.peer_name}
                  </strong>
                  <span>{formatDuration(h.duration_ms)}</span>
                </div>
                <p>
                  {({ control: "远程控制", view: "只看画面" } as Record<string, string>)[h.capability] ?? h.capability}{" "}
                  · {formatWhen(h.started_ms)}
                  {h.reason ? ` · ${h.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
          {confirm ? (
            <div className={styles.choices}>
              <MobileNotice tone="warning">清空后无法恢复，是否继续？</MobileNotice>
              <button type="button" className={ui.danger} disabled={clearing} onClick={() => void clear()}>
                {clearing ? "正在清空…" : "确认清空"}
              </button>
              <button type="button" className={ui.secondary} disabled={clearing} onClick={() => setConfirm(false)}>
                保留记录
              </button>
            </div>
          ) : (
            <button type="button" className={ui.textButton} onClick={() => setConfirm(true)}>
              清空
            </button>
          )}
        </>
      )}
    </>
  );
}
