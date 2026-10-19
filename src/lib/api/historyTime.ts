import { invoke } from "@tauri-apps/api/core";
export interface HistoryTimeDistribution {
  days: { date: string; count: number }[];
  selected_date: string;
  hours: number[];
  sources: { source: string; count: number }[];
  selection_count: number;
}
export interface HistoryTimeQuery {
  workspace: string; search: string; filter: string; time_filter: string;
  source: string; group_filter: string; tag_ids: string[];
  start_date: string; end_date: string; selected_date: string;
}
export const getHistoryTimeDistribution = (requestId: string, query: HistoryTimeQuery) =>
  invoke<HistoryTimeDistribution>("get_history_time_distribution", { requestId, query });
