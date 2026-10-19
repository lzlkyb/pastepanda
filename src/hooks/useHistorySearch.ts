import { useEffect } from "react";
import { useAppStore, buildSearchKey } from "@/stores/appStore";
import { searchHistory } from "@/lib/api/history";
import { isHistoryQueryActive } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { useWindowVisible } from "./useWindowVisible";

/** Time/source-only queries need the database too: older matches may never enter the loaded page. */
export function useHistorySearch(enabled = true) {
  const visible = useWindowVisible();
  const search = useAppStore(s => s.searchKeyword);
  const filter = useAppStore(s => s.filterType);
  const time = useAppStore(s => s.timeFilter);
  const source = useAppStore(s => s.sourceFilter);
  const group = useAppStore(s => s.groupFilter);
  const tags = useAppStore(s => s.selectedTagIds);
  const workspace = useAppStore(s => s.config.current_workspace);
  const version = useAppStore(s => s.historyVersion);
  const retry = useAppStore(s => s.searchRetryTick);
  useEffect(() => {
    if (!enabled || !visible) return;
    const store = useAppStore.getState();
    if (!isHistoryQueryActive(search, time, source)) {
      useAppStore.setState({ searchResults: null, searchResultsKey: "", searchLoading: false, searchError: false });
      return;
    }
    const key = buildSearchKey(store);
    if (store.searchResults !== null && store.searchResultsKey === key && !store.searchError && !store.searchLoading) return;
    let cancelled = false;
    // Do not present a previous date's cards as matches for the newly selected range.
    useAppStore.setState({ searchResults: [], searchResultsKey: key, searchLoading: true, searchError: false });
    searchHistory({ search, filter, timeFilter: time, source, groupFilter: group, tagIds: tags }).then(results => {
      if (!cancelled) store.setSearchResults(results, key);
    }).catch(error => {
      if (!cancelled) { logger.warn("历史记录查询失败", error); store.setSearchError(true); }
    });
    // Clearing a time range also invalidates the request; no late response may restore it.
    return () => { cancelled = true; };
  }, [enabled, visible, search, filter, time, source, group, tags, workspace, version, retry]);
}
