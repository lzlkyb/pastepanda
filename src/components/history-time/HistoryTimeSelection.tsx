import { Clock, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { historyTimeLabel } from "@/lib/utils";
import { SourceIdentity } from "@/components/history-source/SourceIdentity";
import styles from "./HistoryTime.module.css";

export function HistoryTimeSelection() {
  const value = useAppStore(s => s.timeFilter);
  const clear = useAppStore(s => s.setTimeFilter);
  const source = useAppStore(s => s.sourceFilter);
  const clearSource = useAppStore(s => s.setSourceFilter);
  const loading = useAppStore(s => s.searchLoading);
  const error = useAppStore(s => s.searchError);
  const retry = useAppStore(s => s.retrySearch);
  if (value === "all" && !source) return null;
  return <div className={styles.selection}>
    {value !== "all" && <span className={styles.chip}><Clock size={12} />{historyTimeLabel(value)}<button type="button" aria-label="清除时间条件" onClick={() => clear("all")}><X size={12} /></button></span>}
    {source && <span className={styles.chip}><SourceIdentity source={source} /><button type="button" aria-label="清除来源条件" onClick={() => clearSource("")}><X size={12} /></button></span>}
    {error ? <><span className={styles.error} role="alert">记录读取失败</span><button type="button" onClick={retry}>重试查询</button></>
      : <span role="status">{loading ? "正在查询历史记录…" : ""}</span>}
    {value !== "all" && <button type="button" onClick={() => clear("all")}>查看全部时间</button>}
  </div>;
}
