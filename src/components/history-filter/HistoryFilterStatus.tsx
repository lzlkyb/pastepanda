import { useAppStore } from "@/stores/appStore";
import { useFilteredItems } from "@/hooks/useFilteredItems";
import { useHistoryQueryStatus } from "@/hooks/useHistoryQueryStatus";
import { HISTORY_TYPE_TABS } from "./HistoryTypeTabs";
import styles from "./HistoryFilterStatus.module.css";

export function HistoryFilterStatus() {
  const type = useAppStore(s => s.filterType);
  const retry = useAppStore(s => s.retrySearch);
  const items = useFilteredItems();
  const { pending, error } = useHistoryQueryStatus();
  const label = HISTORY_TYPE_TABS.find(tab => tab.key === type)!.label;
  return <span className={styles.status} role="status" aria-live="polite">
    <b>{label}</b><span>· {pending ? "正在切换" : error ? "读取失败" : `已显示 ${items.length.toLocaleString()} 条`}</span>
    {error && <button type="button" onClick={retry}>重试</button>}
  </span>;
}
