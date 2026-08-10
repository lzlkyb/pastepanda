//! AI 反馈与动作偏好命令层（M3）。
//!
//! ai_feedback_add 记一笔结果反馈（accepted/edited/rejected）；
//! ai_feedback_stats 按动作聚合“被改率”；
//! action_pref_get/set 读写动作偏好指令。
//! **偏好指令变化会改变 AI 输出 → set 时清缓存**（旧缓存命中会拿旧偏好结果）。

use crate::ai::cache;
use crate::data_store::{AiFeedback, AiFeedbackStat, ActionPrefRow, DataStore, PrefSignalTop};
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

// ============================================================
// 偏好自荐：特征信号 → 待确认的偏好建议
// ============================================================

/// 上报一批特征标签（前端 `extractPrefFeatures` 本地算出来的）。
///
/// 非法特征在 store 层静默丢弃；这里不报错是故意的——记账失败不能卡住用户复制产物。
#[tauri::command]
pub fn pref_signal_add(
    store: State<DataStore>,
    action_id: String,
    features: Vec<String>,
) -> Result<(), String> {
    store.pref_signal_add(&action_id, &features);
    Ok(())
}

/// 查某动作是不是已经攒够信号可以提议了（未达阈值 / 已处理 → None）。
#[tauri::command]
pub fn pref_signal_top(
    store: State<DataStore>,
    action_id: String,
) -> Result<Option<PrefSignalTop>, String> {
    store.pref_signal_top(&action_id)
}

/// 用户点了「记住」：写入偏好 + 标记已处理 + 清缓存。
///
/// **合成一个命令而不是让前端连调两次**：分开调的失败模式是
/// “偏好已写入但没标记已处理”，结果是同一条建议反反复复弹——
/// 而用户已经答应过了。那是主动建议里最惹人的一类 bug。
#[tauri::command]
pub fn pref_signal_accept(
    store: State<DataStore>,
    action_id: String,
    feature: String,
    preference: String,
) -> Result<(), String> {
    // 先校验再写：特征非法就不应该动 action_prefs
    store.pref_signal_done(&action_id, &feature)?;
    store.action_pref_set(&action_id, &preference)?;
    // 偏好变了 = 输出会变，旧缓存不能再命中（同 action_pref_set）
    cache::clear();
    Ok(())
}

/// 用户点了「✕ 不用」：只标记已处理，不写偏好。否决被记住（红线②）。
#[tauri::command]
pub fn pref_signal_dismiss(
    store: State<DataStore>,
    action_id: String,
    feature: String,
) -> Result<(), String> {
    store.pref_signal_done(&action_id, &feature)
}

/// 一键清空偏好信号（「系统学到了什么」里的清除按钮）。
#[tauri::command]
pub fn pref_signal_clear(store: State<DataStore>) -> Result<u32, String> {
    store.pref_signal_clear()
}
