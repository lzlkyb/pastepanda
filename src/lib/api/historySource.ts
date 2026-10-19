import { invoke } from "@tauri-apps/api/core";

export interface SourceMetrics {
  count: number;
  text_count: number;
  image_count: number;
  file_count: number;
  other_count: number;
  latest_time: string | null;
}
export interface HistorySourceEntry extends SourceMetrics {
  source: string;
  source_icon: string | null;
}
export interface HistorySourceDistribution {
  total: SourceMetrics;
  sources: HistorySourceEntry[];
}
// Source is deliberately absent: distribution must retain the alternative apps.
export interface HistorySourceQuery {
  workspace: string; search: string; filter: string; time_filter: string;
  group_filter: string; tag_ids: string[];
}
export const getHistorySourceDistribution = (requestId: string, query: HistorySourceQuery) =>
  invoke<HistorySourceDistribution>("get_history_source_distribution", { requestId, query });
