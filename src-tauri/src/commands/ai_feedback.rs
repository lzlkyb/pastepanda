//! AI 反馈与动作偏好命令层（M3）。
//!
//! ai_feedback_add 记一笔结果反馈（accepted/edited/rejected）；
//! ai_feedback_stats 按动作聚合“被改率”；
//! action_pref_get/set 读写动作偏好指令。
//! **偏好指令变化会改变 AI 输出 → set 时清缓存**（旧缓存命中会拿旧偏好结果）。

use crate::ai::cache;
use crate::data_store::{AiFeedback, AiFeedbackStat, ActionPrefRow, DataStore};
use tauri::State;

#[tauri::command]
pub fn ai_feedback_add(store: State<DataStore>, feedback: AiFeedback) -> Result<(), String> {
    store.ai_feedback_add(&feedback);
    Ok(())
}

#[tauri::command]
pub fn ai_feedback_stats(
    store: State<DataStore>,
    days: Option<u32>,
) -> Result<Vec<AiFeedbackStat>, String> {
    store.ai_feedback_stats(days.unwrap_or(30).clamp(1, 90))
}

#[tauri::command]
pub fn ai_feedback_clear(store: State<DataStore>) -> Result<u32, String> {
    store.ai_feedback_clear()
}

#[tauri::command]
pub fn action_pref_get(store: State<DataStore>, action_id: String) -> Result<String, String> {
    store.action_pref_get(&action_id)
}

#[tauri::command]
pub fn action_pref_set(store: State<DataStore>, action_id: String, preference: String) -> Result<(), String> {
    store.action_pref_set(&action_id, &preference)?;
    // 偏好变了 = 输出会变，旧缓存不能再命中
    cache::clear();
    Ok(())
}

#[tauri::command]
pub fn action_prefs_all(store: State<DataStore>) -> Result<Vec<ActionPrefRow>, String> {
    store.action_prefs_all()
}
