//! 动作使用日志命令层（v6.0 起步，v6.1 扩展为个性化推荐的数据口）。
//!
//! 三组命令：
//! - **记录**：`action_event_log` 记一笔（fire-and-forget，写失败不阻塞主流程）；
//! - **学习数据**：`action_recommend_weights` 给前端算个性化排序权重（按内容类型 × 动作的
//!   使用频次），`action_dismiss_add` / `action_dismissals` 管「不再推荐这个」负反馈；
//! - **红线②（可见可删）**：`action_event_stats` 是「系统学到了什么」的数据源，
//!   `action_learnings_clear` 一键清空（事件 + 负反馈一起清）。

use crate::data_store::{
    ActionDismissal, ActionEvent, ActionEventStats, ActionPin, ActionWeightRow, DataStore,
    SceneWeightRow,
};
use tauri::{Emitter, State};

/// 记一笔动作事件。无返回值、不报错——失败只在 Rust 侧记 warn 日志。
/// 审查 #1（学习回流）：写成功后广播 `action-event-recorded`，前端 debounce 刷新推荐权重，
/// 让"用了 → 权重变 → 建议变"在会话内可见，而不是等到下次启动。
#[tauri::command]
pub fn action_event_log(app: tauri::AppHandle, store: State<DataStore>, event: ActionEvent) {
    store.action_event_add(&event);
    let _ = app.emit("action-event-recorded", ());
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

/// 恢复一条「不再推荐」（智能学习弹窗的恢复按钮）。
#[tauri::command]
pub fn action_dismiss_remove(
    store: State<DataStore>,
    action_id: String,
    content_type: String,
) -> Result<u32, String> {
    store.action_dismiss_remove(&action_id, &content_type)
}

// ===================== 常用置顶（v6.14，正向偏好） =====================

/// 置顶一个动作（幂等）。content_type 空串 = 全局置顶。
///
/// 后端会顺手清掉该动作的「不再推荐」——前端不用调两次，
/// 也不会因为某个入口忘了调而留下矛盾状态。
#[tauri::command]
pub fn action_pin_add(store: State<DataStore>, action_id: String, content_type: String) {
    store.action_pin_add(&action_id, &content_type);
}

/// 全部置顶列表。
#[tauri::command]
pub fn action_pins(store: State<DataStore>) -> Result<Vec<ActionPin>, String> {
    store.action_pins()
}

/// 取消置顶。返回删除条数。
#[tauri::command]
pub fn action_pin_remove(
    store: State<DataStore>,
    action_id: String,
    content_type: String,
) -> Result<u32, String> {
    store.action_pin_remove(&action_id, &content_type)
}

/// 一键清空全部学习记录（事件 + 负反馈），返回删除条数。红线②。
///
/// **不碰 `action_pins`**：置顶是用户**显式设的偏好**，不是系统学来的产物。
/// 这一点与 `action_prefs`（输出偏好指令）一致——那个也不被本命令清，
/// 且自进化面板里已经写明“清反馈不影响偏好指令”。把用户手动设的东西当成
/// “学习记录”一起清掉，在用户看来就是把他的配置弄没了。
#[tauri::command]
pub fn action_learnings_clear(store: State<DataStore>) -> Result<u32, String> {
    let n1 = store.action_event_clear()?;
    let n2 = store.action_dismissals_clear()?;
    Ok(n1 + n2)
}
