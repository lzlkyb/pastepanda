use crate::data_store::{DataStore, Snippet};
use tauri::State;

/// 添加片段
#[tauri::command]
pub fn add_snippet(
    store: State<DataStore>,
    name: String,
    content: String,
) -> Result<String, String> {
    store.add_snippet(&name, &content)
}

/// 获取所有片段
#[tauri::command]
pub fn get_snippets(store: State<DataStore>) -> Result<Vec<Snippet>, String> {
    store.get_snippets()
}

/// 更新片段
#[tauri::command]
pub fn update_snippet(
    store: State<DataStore>,
    id: String,
    name: String,
    content: String,
    tag: String,
) -> Result<(), String> {
    store.update_snippet(&id, &name, &content, &tag)
}

/// 删除片段
#[tauri::command]
pub fn delete_snippet(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_snippet(&id)
}

/// 记录片段被使用（复制）
#[tauri::command]
pub fn use_snippet(store: State<DataStore>, id: String) -> Result<(), String> {
    store.use_snippet(&id)
}
