use crate::data_store::{DataStore, HistoryItem, Stats};
use tauri::{Manager, State};

#[tauri::command]
pub fn get_history(
    store: State<DataStore>,
    workspace: String,
    filter: String,
    search: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    store.get_history(&workspace, &filter, &search, offset, limit)
}

#[tauri::command]
pub fn insert_history(store: State<DataStore>, item: HistoryItem) -> Result<(), String> {
    store.insert_history(&item)
}

/// 更新历史记录（编辑对话框用）
#[tauri::command]
pub fn update_history(store: State<DataStore>, id: String, text: String) -> Result<(), String> {
    store.update_history(&id, &text)
}

#[tauri::command]
pub fn delete_history(store: State<DataStore>, ids: Vec<String>) -> Result<u32, String> {
    store.delete_history(&ids)
}

#[tauri::command]
pub fn toggle_pin(store: State<DataStore>, id: String) -> Result<bool, String> {
    store.toggle_pin(&id)
}

#[tauri::command]
pub fn clear_history(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
) -> Result<serde_json::Value, String> {
    // 修复 Low：单次原子操作完成 读取被删记录 + 删除，避免读写竞态
    let (count, deleted_items) = store.clear_history_with_undo(&workspace, before_days)?;
    Ok(serde_json::json!({
        "count": count,
        "deleted_items": deleted_items,
    }))
}

#[tauri::command]
pub fn get_config(store: State<DataStore>) -> Result<serde_json::Value, String> {
    store.get_config()
}

#[tauri::command]
pub fn save_config(
    store: State<DataStore>,
    config: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.save_config(&config)?;

    // 刷新剪贴板监听器的 auto_strip 缓存，避免每次都锁数据库读取配置
    if let Some(monitor) = app.try_state::<crate::clipboard_monitor::ClipboardMonitor>() {
        let auto_strip = config
            .get("auto_strip")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        monitor.update_auto_strip_cache(auto_strip);

        // 修复 U36：刷新敏感内容防护缓存（默认开启）
        let skip_sensitive = config
            .get("skip_sensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let excluded_apps: Vec<String> = config
            .get("excluded_apps")
            .and_then(|v| v.as_str())
            .map(|s| {
                s.split(',')
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        monitor.update_sensitive_cache(skip_sensitive, excluded_apps);
    }

    Ok(())
}

#[tauri::command]
pub fn get_stats(store: State<DataStore>, workspace: String) -> Result<Stats, String> {
    store.get_stats(&workspace)
}

/// 导入历史记录
#[tauri::command]
pub fn import_history(store: State<DataStore>, items: Vec<HistoryItem>) -> Result<u32, String> {
    store.import_history(&items)
}

/// 获取全部历史记录（用于导出）
#[tauri::command]
pub fn get_all_history(
    store: State<DataStore>,
    workspace: String,
) -> Result<Vec<HistoryItem>, String> {
    store.get_all_history(&workspace)
}
