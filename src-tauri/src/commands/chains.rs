//! 动作链命令层（X1 B2）。
//!
//! 仿 commands/ai.rs 的自定义动作 CRUD：list / save / delete / reorder。
//! 步骤引用的变换是否存在由前端校验（变换注册表在前端），后端只管存取与结构约束。

use crate::data_store::{ChainDef, DataStore};
use tauri::State;

#[tauri::command]
pub fn chain_list(store: State<DataStore>) -> Result<Vec<ChainDef>, String> {
    store.chains()
}

#[tauri::command]
pub fn chain_save(store: State<DataStore>, chain: ChainDef) -> Result<String, String> {
    store.chain_save(&chain)
}

#[tauri::command]
pub fn chain_delete(store: State<DataStore>, id: String) -> Result<(), String> {
    store.chain_delete(&id)
}

#[tauri::command]
pub fn chain_reorder(store: State<DataStore>, ids: Vec<String>) -> Result<(), String> {
    store.chains_reorder(&ids)
}
