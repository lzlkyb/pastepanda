import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { getHistorySourceDistribution, type HistorySourceDistribution } from "@/lib/api/historySource";
import { cancelStorageRequest } from "@/lib/api/storage";
import { historyLocalDate } from "@/lib/utils";
import { useWindowVisible } from "./useWindowVisible";

export function useHistorySourceDistribution(open: boolean) {
  const workspace = useAppStore(s => s.config.current_workspace);
  const search = useAppStore(s => s.searchKeyword);
  const filter = useAppStore(s => s.filterType);
  const time = useAppStore(s => s.timeFilter);
  const group = useAppStore(s => s.groupFilter);
  const tags = useAppStore(s => s.selectedTagIds);
  const version = useAppStore(s => s.historyVersion);
  const visible = useWindowVisible();
  const today = historyLocalDate(new Date());
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([workspace, search, filter, time, group, tags, version, today, revision]);
  const [snapshot, setSnapshot] = useState<{ key: string; data: HistorySourceDistribution } | null>(null);
  const [failure, setFailure] = useState({ key: "", message: "" });
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    let requestId: string | null = null;
    setFailure({ key, message: "" });
    // Coalesce search edits and clipboard bursts; no scan while the panel is hidden.
    const timer = window.setTimeout(() => {
      requestId = crypto.randomUUID();
      void getHistorySourceDistribution(requestId, {
        workspace, search, filter, time_filter: time, group_filter: group, tag_ids: tags,
      }).then(data => {
        if (!cancelled) setSnapshot({ key, data });
      }).catch(() => {
        if (!cancelled) setFailure({ key, message: "来源分布读取失败，当前筛选和记录列表已保留。" });
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (requestId) void cancelStorageRequest(requestId).catch(() => {});
    };
  }, [open, visible, key, workspace, search, filter, time, group, tags]);
  const error = failure.key === key ? failure.message : "";
  const data = snapshot?.key === key ? snapshot.data : null;
  return { data, error, loading: open && visible && !data && !error, refresh: () => setRevision(v => v + 1) };
}
