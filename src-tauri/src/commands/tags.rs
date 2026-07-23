use crate::data_store::{DataStore, Tag};
use tauri::State;

#[tauri::command]
pub fn get_tags(store: State<DataStore>) -> Result<Vec<Tag>, String> {
    store.get_tags()
}

#[tauri::command]
pub fn create_tag(store: State<DataStore>, name: String, color: String) -> Result<Tag, String> {
    store.create_tag(&name, &color)
}

#[tauri::command]
pub fn update_tag(
    store: State<DataStore>,
    id: String,
    name: String,
    color: String,
) -> Result<(), String> {
    store.update_tag(&id, &name, &color)
}

#[tauri::command]
pub fn delete_tag(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_tag(&id)
}

#[tauri::command]
pub fn set_item_tags(
    store: State<DataStore>,
    history_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    store.set_item_tags(&history_id, &tag_ids)
}

#[tauri::command]
pub fn add_item_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
    tag_ids: Vec<String>,
) -> Result<u32, String> {
    store.add_item_tags(&history_ids, &tag_ids)
}

#[tauri::command]
pub fn remove_item_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
    tag_ids: Vec<String>,
) -> Result<u32, String> {
    store.remove_item_tags(&history_ids, &tag_ids)
}

#[tauri::command]
pub fn get_items_with_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
) -> Result<Vec<(String, Vec<Tag>)>, String> {
    store.get_items_with_tags(&history_ids)
}

/// 将指定记录的所有自动标签转为手动标签（用户确认 AI 分类结果）
#[tauri::command]
pub fn confirm_auto_tags(
    store: State<DataStore>,
    history_id: String,
) -> Result<(), String> {
    store.confirm_auto_tags(&history_id)
}
