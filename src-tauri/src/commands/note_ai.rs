//! 笔记轻量 AI 产物的写入命令（B1 ＋轻量 AI）。
//!
//! 🔴 **这里不调模型，也不判 `ai_enabled`**。前端先走 `ai_run`（那条路上有
//! 开关门控、出网闸、预算、缓存、用量日志），拿到输出后再调这里落库。
//!
//! 为什么不把两步合成一个命令：`ai_run` 会返回「需要确认」与「超预算」这两种
//! **不是错误的正常结果**，得由前端分支处理（弹确认框 / 提示预算）。
//! 包成一个命令就得把那套状态机在后端再造一遍。

use crate::data_store::DataStore;
use tauri::State;

/// 写一行摘要。`summary` 为 `None` = 清掉已有摘要。
#[tauri::command]
pub fn note_set_summary(
    store: State<DataStore>,
    id: String,
    summary: Option<String>,
) -> Result<(), String> {
    store.note_set_summary(&id, summary.as_deref())
}

/// 把模型输出里的标签追加给笔记（标为 `source='ai'`），返回真正新增的那几个。
///
/// 解析在后端（`parse_ai_tags`）而不是前端：它是纯函数、容错规则多，放后端才能写单测。
#[tauri::command]
pub fn note_add_ai_tags(
    store: State<DataStore>,
    note_id: String,
    raw: String,
) -> Result<Vec<String>, String> {
    store.note_add_ai_tags(&note_id, &raw)
}

/// 用户确认：把这篇笔记的 AI 标签转成手动标签。
#[tauri::command]
pub fn note_confirm_ai_tags(store: State<DataStore>, note_id: String) -> Result<(), String> {
    store.note_confirm_ai_tags(&note_id)
}
