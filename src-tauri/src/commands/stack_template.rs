//! 粘贴栈常用模板命令层（P4）。
//!
//! 仿 commands/chains.rs 的极简风格：list / save / delete 直接转发给 DataStore，
//! 验证都在 data_store 层做。

use crate::data_store::{DataStore, StackTemplate, StackTemplateItem};
use tauri::State;

#[tauri::command]
pub fn stack_template_list(store: State<DataStore>) -> Result<Vec<StackTemplate>, String> {
    store.stack_templates()
}

#[tauri::command]
pub fn stack_template_save(
    store: State<DataStore>,
    name: String,
    items: Vec<StackTemplateItem>,
) -> Result<String, String> {
    store.stack_template_save(&name, &items)
}

#[tauri::command]
pub fn stack_template_delete(store: State<DataStore>, id: String) -> Result<(), String> {
    store.stack_template_delete(&id)
}

#[tauri::command]
pub fn stack_template_touch(store: State<DataStore>, id: String) -> Result<(), String> {
    store.stack_template_touch(&id)
}
