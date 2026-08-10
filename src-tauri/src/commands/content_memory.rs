//! 内容记忆命令层（M5-1）。
//! backfill（启动懒回填）/ count / clear（可见可删，红线②）。

use crate::data_store::DataStore;
use tauri::State;

#[tauri::command]
pub fn history_summaries_backfill(
    store: State<DataStore>,
    limit: Option<i64>,
) -> Result<u32, String> {
    store.history_summaries_backfill(limit.unwrap_or(500))
}

#[tauri::command]
pub fn history_summaries_count(store: State<DataStore>) -> Result<u32, String> {
    store.history_summaries_count()
}

#[tauri::command]
pub fn history_summaries_clear(store: State<DataStore>) -> Result<u32, String> {
    store.history_summaries_clear()
}
