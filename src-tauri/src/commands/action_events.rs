//! 动作使用日志命令层（v6.0 起步，v6.1 扩展为个性化推荐的数据口）。
//!
//! 三组命令：
//! - **记录**：`action_event_log` 记一笔（fire-and-forget，写失败不阻塞主流程）；
//! - **学习数据**：`action_recommend_weights` 给前端算个性化排序权重（按内容类型 × 动作的
//!   使用频次），`action_dismiss_add` / `action_dismissals` 管「不再推荐这个」负反馈；
//! - **红线②（可见可删）**：`action_event_stats` 是「系统学到了什么」的数据源，
//!   `action_learnings_clear` 一键清空（事件 + 负反馈一起清）。

use crate::data_store::{
    ActionDismissal, ActionEvent, ActionEventStats, ActionWeightRow, DataStore, SceneWeightRow,
};
use tauri::State;

/// 记一笔动作事件。无返回值、不报错——失败只在 Rust 侧记 warn 日志。
#[tauri::command]
pub fn action_event_log(store: State<DataStore>, event: ActionEvent) {
    store.action_event_add(&event);
}

/// 最近 N 天的动作事件统计（默认 30 天，上限 365）。
#[tauri::command]
pub fn action_event_stats(
    store: State<DataStore>,
    days: Option<u32>,
) -> Result<ActionEventStats, String> {
    Ok(store.action_event_stats(days.unwrap_or(30)))
}

/// 清空全部动作事件，返回删除条数。
#[tauri::command]
pub fn action_event_clear(store: State<DataStore>) -> Result<u32, String> {
    store.action_event_clear()
}

/// 个性化排序权重（v6.1）：近 N 天按 (动作 × 内容类型) 的使用频次。
/// 前端据此调整变换推荐排序；数据不足时走冷启动（退回静态分）。
#[tauri::command]
pub fn action_recommend_weights(
    store: State<DataStore>,
    days: Option<u32>,
) -> Vec<ActionWeightRow> {
    store.action_recommend_weights(days.unwrap_or(14))
}

/// 场景权重（v6.2 来源+时段感知）：近 N 天按
/// (动作 × 内容类型 × 时段桶 × 来源类别) 的使用频次。
/// 前端据此在「工作时间 IDE / 晚上浏览器」等场景下微调推荐。
#[tauri::command]
pub fn action_recommend_scene_weights(
    store: State<DataStore>,
    days: Option<u32>,
) -> Vec<SceneWeightRow> {
    store.action_scene_weights(days.unwrap_or(14))
}

/// 记一条「不再推荐这个」负反馈。(action_id, content_type) 重复记幂等。
/// content_type 空串 = 该动作在哪儿都不推荐。
#[tauri::command]
pub fn action_dismiss_add(
    store: State<DataStore>,
    action_id: String,
    content_type: String,
) {
    store.action_dismiss_add(&action_id, &content_type);
}

/// 全部负反馈列表。
#[tauri::command]
pub fn action_dismissals(store: State<DataStore>) -> Result<Vec<ActionDismissal>, String> {
    store.action_dismissals()
}

/// 一键清空全部学习记录（事件 + 负反馈），返回删除条数。红线②。
#[tauri::command]
pub fn action_learnings_clear(store: State<DataStore>) -> Result<u32, String> {
    let n1 = store.action_event_clear()?;
    let n2 = store.action_dismissals_clear()?;
    Ok(n1 + n2)
}
