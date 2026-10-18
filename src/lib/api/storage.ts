import { invoke } from "@tauri-apps/api/core";

export interface StorageFile {
  name: string;
  category: "database" | "images" | "cache" | "other";
  bytes: number;
  complete: boolean;
  error: string | null;
}
export interface StorageOverview {
  root_path: string;
  database_bytes: number;
  total_bytes: number;
  complete: boolean;
  files: StorageFile[];
  measured_at: string;
}
export interface TableUsage {
  name: string;
  table_bytes: number | null;
  index_bytes: number | null;
  internal_tables: string[];
}
export interface DatabaseUsage {
  page_bytes: number;
  free_bytes: number;
  other_bytes: number | null;
  size_supported: boolean;
  tables: TableUsage[];
}
export const getStorageOverview = (requestId: string, scanDirectories: boolean) =>
  invoke<StorageOverview>("get_storage_overview", { requestId, scanDirectories });
export const getStorageDatabase = (requestId: string) =>
  invoke<DatabaseUsage>("get_storage_database", { requestId });
export const cancelStorageRequest = (requestId: string) =>
  invoke<void>("cancel_storage_request", { requestId });

/** Only completed data-management operations request a rescan; clipboard arrivals just mark stale. */
export function invalidateStorageStats() {
  window.dispatchEvent(new Event("storage-usage-invalidated"));
}
