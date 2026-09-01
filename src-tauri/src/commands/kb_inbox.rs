//! 待沉淀区命令层（知识库 A 阶段 · 规划 §8.1 4️⃣）。
//!
//! 同 `notes.rs`：只转发 + 分页兜底，业务在 `data_store::kb_inbox`。
//!
//! 🔴 红线：无 AI。候选完全由本机信号（收藏 / 搜索命中数）算出，不读内容、不出网。

use crate::data_store::{DataStore, InboxCandidate, InboxGroupCount, InboxViewOpts};
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
    view: Option<InboxViewOpts>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<InboxCandidate>, String> {
    let limit = match limit {
        Some(n) if n > 0 => n.min(MAX_PAGE),
        _ => DEFAULT_PAGE,
    };
    store.kb_inbox_list_view(
        &workspace,
        &validated_inbox_view(view),
        limit,
        offset.unwrap_or(0),
    )
}

/// 校视图选项，未知值记 warn 后退回默认（同 notes.rs 的 `validated_view`）。
///
/// 两边各写一份而不是泛型共用：枚举取值本身完全不同，共用只能共用到一个 `contains`。
/// `types` 不校：它是 `content_type` 的开放集合（后端分类器可能新增类型），
/// 校了只会在加新类型时抗拒合法值。认不出的类型自然筛不到东西，不会错。
fn validated_inbox_view(view: Option<InboxViewOpts>) -> InboxViewOpts {
    let v = view.unwrap_or_default();
    const SORTS: [&str; 4] = ["", "signal", "recent", "recopy"];
    const GROUPS: [&str; 4] = ["", "type", "source", "reason"];
    const REASONS: [&str; 3] = ["", "star", "research"];
    const TRI: [&str; 3] = ["", "yes", "no"];
    if !SORTS.contains(&v.sort.as_str()) {
        log::warn!("[KbInbox] 未知排序 `{}`，退回默认", v.sort);
    }
    if !GROUPS.contains(&v.group_by.as_str()) {
        log::warn!("[KbInbox] 未知分组 `{}`，退回不分组", v.group_by);
    }
    if !REASONS.contains(&v.reason.as_str()) {
        log::warn!("[KbInbox] 未知入选原因 `{}`，当作不筛", v.reason);
    }
    if !TRI.contains(&v.pasted.as_str()) {
        log::warn!("[KbInbox] 筛选 pasted 的值 `{}` 不是三态之一，当作不筛", v.pasted);
    }
    v
}

/// 候选总数（横幅计数）。带筛选时返回的是**筛选后**的数，
/// 否则横幅会说 225 条而列表里只有 12 条。
#[tauri::command]
pub fn kb_inbox_count(
    store: State<DataStore>,
    workspace: String,
    view: Option<InboxViewOpts>,
) -> Result<i64, String> {
    store.kb_inbox_count_view(&workspace, &validated_inbox_view(view))
}

/// 每个分组的真实条数（B2 #9）。组名是原始值，前端负责映射成中文。
#[tauri::command]
pub fn kb_inbox_group_counts(
    store: State<DataStore>,
    workspace: String,
    view: Option<InboxViewOpts>,
) -> Result<Vec<InboxGroupCount>, String> {
    store.kb_inbox_group_counts(&workspace, &validated_inbox_view(view))
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
