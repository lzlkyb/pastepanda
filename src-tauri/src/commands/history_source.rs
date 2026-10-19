use crate::data_store::{
    history_source::{self, HistorySourceDistribution, HistorySourceQuery},
    DataStore,
};
use tauri::State;

#[tauri::command]
pub async fn get_history_source_distribution(
    store: State<'_, DataStore>,
    request_id: String,
    query: HistorySourceQuery,
) -> Result<HistorySourceDistribution, String> {
    let path = store.storage_path();
    super::storage::run(request_id, move |task| {
        history_source::distribution(&path, task, &query)
    })
    .await
}
