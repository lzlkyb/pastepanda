/**
 * api/contentMemory.ts — 内容记忆（M5-1，纯本地检索摘要）。
 * 对应 Rust：data_store/content_memory.rs + commands/content_memory.rs。
 */

import { invoke } from "@tauri-apps/api/core";

export const historySummariesBackfill = (limit?: number) =>
  invoke<number>("history_summaries_backfill", { limit });

export const historySummariesCount = () => invoke<number>("history_summaries_count");

export const historySummariesClear = () => invoke<number>("history_summaries_clear");
