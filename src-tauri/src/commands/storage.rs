use crate::data_store::{
    storage::{self, DatabaseUsage, ReadTask, StorageOverview},
    DataStore,
};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};
use tauri::State;

static TASKS: LazyLock<Mutex<HashMap<String, Arc<ReadTask>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct TaskGuard(String);
impl Drop for TaskGuard {
    fn drop(&mut self) {
        TASKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub(super) async fn run<T: Send + 'static>(
    id: String,
    work: impl FnOnce(&ReadTask) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let task = Arc::new(ReadTask::default());
    {
        let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
        if tasks.contains_key(&id) {
            return Err("统计请求重复".into());
        }
        tasks.insert(id.clone(), task.clone());
    }
    let guard = TaskGuard(id);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        work(&task)
    })
    .await
    .map_err(|e| format!("统计任务失败：{e}"))?
}

#[tauri::command]
pub async fn get_storage_overview(
    store: State<'_, DataStore>,
    request_id: String,
    scan_directories: bool,
) -> Result<StorageOverview, String> {
    let path = store.storage_path();
    run(request_id, move |task| {
        storage::overview(&path, task, scan_directories)
    })
    .await
}

#[tauri::command]
pub async fn get_storage_database(
    store: State<'_, DataStore>,
    request_id: String,
) -> Result<DatabaseUsage, String> {
    let path = store.storage_path();
    run(request_id, move |task| storage::database_usage(&path, task)).await
}

#[tauri::command]
pub fn cancel_storage_request(request_id: String) {
    if let Some(task) = TASKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
    {
        task.cancel();
    }
}
