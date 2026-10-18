import type { DatabaseUsage, StorageOverview } from "@/lib/api/storage";
export const MiB = 1024 * 1024;
export const storageOverview: StorageOverview = {
  root_path: "C:\\app-data", database_bytes: 136 * MiB, total_bytes: 472 * MiB, complete: true,
  measured_at: "2026-10-18 15:30:00",
  files: [
    { name: "clipboard.db", category: "database", bytes: 128 * MiB, complete: true, error: null },
    { name: "clipboard.db-wal", category: "database", bytes: 8 * MiB, complete: true, error: null },
    { name: "images", category: "images", bytes: 316 * MiB, complete: true, error: null },
    { name: "thumbnails", category: "cache", bytes: 20 * MiB, complete: true, error: null },
  ],
};
export const storageDatabase: DatabaseUsage = {
  page_bytes: 128 * MiB, free_bytes: 12 * MiB, other_bytes: 4 * MiB, size_supported: true,
  tables: [
    { name: "history", table_bytes: 64 * MiB, index_bytes: 8 * MiB, internal_tables: [] },
    { name: "notes", table_bytes: 23 * MiB, index_bytes: MiB, internal_tables: [] },
    { name: "future_table", table_bytes: 16 * MiB, index_bytes: 0, internal_tables: [] },
  ],
};
