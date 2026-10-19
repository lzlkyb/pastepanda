import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { getHistoryTimeDistribution, type HistoryTimeDistribution } from "@/lib/api/historyTime";
import { cancelStorageRequest } from "@/lib/api/storage";
import { historyDateOffset, historyLocalDate } from "@/lib/utils";
import { useWindowVisible } from "./useWindowVisible";

export function useHistoryTimeDistribution(open: boolean, selectedDate: string) {
  const workspace = useAppStore(s => s.config.current_workspace);
  const search = useAppStore(s => s.searchKeyword);
  const filter = useAppStore(s => s.filterType);
  const time = useAppStore(s => s.timeFilter);
  const source = useAppStore(s => s.sourceFilter);
  const group = useAppStore(s => s.groupFilter);
  const tags = useAppStore(s => s.selectedTagIds);
  const version = useAppStore(s => s.historyVersion);
  const visible = useWindowVisible();
  const today = historyLocalDate(new Date());
  const baseKey = JSON.stringify([workspace, search, filter, source, group, tags, today]);
  const key = JSON.stringify([baseKey, time, selectedDate]);
  const [snapshot, setSnapshot] = useState<{ key: string; baseKey: string; data: HistoryTimeDistribution } | null>(null);
  const [failure, setFailure] = useState({ key: "", message: "" });
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    let requestId: string | null = null;
    setLoadingKey(key);
    setFailure({ key, message: "" });
    // Rapid typing and clipboard bursts coalesce; no background polling or startup scan.
    const timer = window.setTimeout(() => {
      requestId = crypto.randomUUID();
      void getHistoryTimeDistribution(requestId, {
        workspace, search, filter, time_filter: time, source, group_filter: group, tag_ids: tags,
        start_date: historyDateOffset(today, -13), end_date: today, selected_date: selectedDate,
      }).then(data => {
        if (!cancelled) setSnapshot({ key, baseKey, data });
      }).catch(() => {
        if (!cancelled) setFailure({ key, message: "时间分布读取失败，当前列表仍可查看。请重新读取。" });
      }).finally(() => { if (!cancelled) setLoadingKey(null); });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (requestId) void cancelStorageRequest(requestId).catch(() => {});
    };
  }, [open, visible, key, baseKey, workspace, search, filter, time, source, group, tags, today, selectedDate, version, revision]);
  return {
    data: snapshot?.baseKey === baseKey ? snapshot.data : null,
    selectionCount: snapshot?.key === key ? snapshot.data.selection_count : null,
    loading: open && visible && loadingKey === key,
    error: failure.key === key ? failure.message : "",
    refresh: () => setRevision(v => v + 1),
  };
}
