import { buildSearchKey, useAppStore } from "@/stores/appStore";
import { isHistoryQueryActive } from "@/lib/utils";

/** Readiness belongs to the current query signature, not the previous tab's flags. */
export function useHistoryQueryStatus() {
  const key = useAppStore(buildSearchKey);
  const active = useAppStore(s => isHistoryQueryActive(s.searchKeyword, s.timeFilter, s.sourceFilter));
  const resultKey = useAppStore(s => s.searchResultsKey);
  const hasResults = useAppStore(s => s.searchResults !== null);
  const loading = useAppStore(s => s.searchLoading);
  const failed = useAppStore(s => s.searchError);
  const current = resultKey === key;
  const error = active && current && failed && !loading;
  const pending = active && (loading || !current || !hasResults);
  return { key, pending, error, ready: !pending && !error };
}
