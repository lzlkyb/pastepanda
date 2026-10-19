use crate::data_store::{
    history_time::{self, HistoryTimeDistribution, HistoryTimeQuery},
    DataStore,
};
use tauri::State;

#[tauri::command]
pub async fn get_history_time_distribution(
    store: State<'_, DataStore>,
    request_id: String,
    query: HistoryTimeQuery,
) -> Result<HistoryTimeDistribution, String> {
    let path = store.storage_path();
    super::storage::run(request_id, move |task| {
        history_time::distribution(&path, task, &query)
    })
    .await
}
