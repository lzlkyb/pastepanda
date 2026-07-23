use crate::data_store::{DataStore, Group};
use tauri::State;

#[tauri::command]
pub fn get_groups(store: State<DataStore>) -> Result<Vec<Group>, String> {
    store.get_groups()
}

#[tauri::command]
pub fn create_group(
    store: State<DataStore>,
    name: String,
    color: String,
    icon: String,
) -> Result<Group, String> {
    store.create_group(&name, &color, &icon)
}

#[tauri::command]
pub fn update_group(
    store: State<DataStore>,
    id: String,
    name: String,
    color: String,
    icon: String,
) -> Result<(), String> {
    store.update_group(&id, &name, &color, &icon)
}

#[tauri::command]
pub fn delete_group(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_group(&id)
}

#[tauri::command]
pub fn reorder_groups(store: State<DataStore>, ids: Vec<String>) -> Result<(), String> {
    store.reorder_groups(&ids)
}

#[tauri::command]
pub fn move_to_group(
    store: State<DataStore>,
    history_ids: Vec<String>,
    group_id: Option<String>,
) -> Result<u32, String> {
    store.move_to_group(&history_ids, group_id.as_deref())
}
