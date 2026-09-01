//! 今日速记（B2 #3 / D11）的命令层。
//!
//! 两个入口（全局热键抓剪贴板 / 卡片右键菜单）共用 `note_append_daily` 这一条，
//! 否则日期归一化、重复判定、首次创建这几件会各写一遍，漂是早晚的事（规则 #11）。
//!
//! 当前时间在**这一层**取，不在 store 里取：那样 store 那个函数永远只能在
//! 「今天」被测，跨天、同日叠加这些分支就写不了用例。

use tauri::State;

use crate::data_store::{DailyAppend, DataStore, Note};

/// 今天的日期（本机时区，`YYYY-MM-DD`）。
///
/// 用本地时区而不是 UTC：“今天”对用户而言就是墙上的日历，
/// 用 UTC 的话东八区凌晨一点记的东西会落到“昨天”。
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_hm() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

/// 往今天那条速记追加一段。
///
/// 返回 `DailyAppend`：`appended` 带上整条笔记，`duplicate` 表示与上一段相同、
/// **没写库**——后者不是错误，是需要前端说一句话的正常分支。
#[tauri::command]
pub fn note_append_daily(
    store: State<DataStore>,
    text: String,
    source: Option<String>,
) -> Result<DailyAppend, String> {
    store.note_append_daily(&today(), &now_hm(), source.as_deref(), &text)
}

/// 某月有速记的日期。`month` 形如 `2026-09`；日历打点用。
#[tauri::command]
pub fn note_daily_dates(store: State<DataStore>, month: String) -> Result<Vec<String>, String> {
    // 形状不对就直接拒，不拿去拼 LIKE：`2026-9` 或 `2026-09-01` 都会让
    // `{month}-%` 变成一个永远匹配不到（或匹配过头）的模式，而前端看到的只是空日历。
    let ok = month.len() == 7
        && month.as_bytes()[4] == b'-'
        && month[..4].bytes().all(|b| b.is_ascii_digit())
        && month[5..].bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return Err(format!("月份格式应为 YYYY-MM，收到: {}", month));
    }
    store.note_daily_dates(&month)
}

/// 最早一条速记的日期。日历翻到头就置灰「‹」（不做无限翻）。
#[tauri::command]
pub fn note_daily_earliest(store: State<DataStore>) -> Result<Option<String>, String> {
    store.note_daily_earliest()
}

/// 今天那条速记（若已存在）。知识页面开第三栏直接定位到今天用。
#[tauri::command]
pub fn note_daily_today(store: State<DataStore>) -> Result<Option<Note>, String> {
    let rows = store.note_list(&format!("daily:{}", today()), &[], 1, 0)?;
    Ok(rows.into_iter().next())
}
