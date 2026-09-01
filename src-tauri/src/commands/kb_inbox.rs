//! 待沉淀区命令层（知识库 A 阶段 · 规划 §8.1 4️⃣）。
//!
//! 同 `notes.rs`：只转发 + 分页兜底，业务在 `data_store::kb_inbox`。
//!
//! 🔴 红线：无 AI。候选完全由本机信号（收藏 / 搜索命中数）算出，不读内容、不出网。

use crate::data_store::{DataStore, InboxCandidate};
use tauri::State;

/// 首屏给多少。**20 是设计稿定的**（§5-2b）：存量 225 条一次铺开 = 收件箱破产，
/// 用户一条都不会处理。
const DEFAULT_PAGE: u32 = 20;

/// 单次上限。同 notes.rs 的理由：调用方传个巨数不应静默把整库读进内存。
const MAX_PAGE: u32 = 200;

/// 待沉淀候选列表。
#[tauri::command]
pub fn kb_inbox_list(
    store: State<DataStore>,
    workspace: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<InboxCandidate>, String> {
    let limit = match limit {
        Some(n) if n > 0 => n.min(MAX_PAGE),
        _ => DEFAULT_PAGE,
    };
    store.kb_inbox_list(&workspace, limit, offset.unwrap_or(0))
}

/// 候选总数（横幅计数）。
#[tauri::command]
pub fn kb_inbox_count(store: State<DataStore>, workspace: String) -> Result<i64, String> {
    store.kb_inbox_count(&workspace)
}

/// 忽略一条候选。`reason` 直接用候选行带回来的那个，不在前端重算。
#[tauri::command]
pub fn kb_inbox_dismiss(
    store: State<DataStore>,
    history_id: String,
    reason: String,
) -> Result<(), String> {
    store.kb_inbox_dismiss(&history_id, &reason)
}

/// 撤销忽略。
#[tauri::command]
pub fn kb_inbox_undismiss(store: State<DataStore>, history_id: String) -> Result<(), String> {
    store.kb_inbox_undismiss(&history_id)
}
