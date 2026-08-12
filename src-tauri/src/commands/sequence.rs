//! commands/sequence.rs —— 程序性记忆命令（V3-B）。
//!
//! `sequence_suggest`：返回最近高频动作序列，前端与已有链去重后
//! 提示「你常这样操作 → 存成动作链？」。只读行为统计，不出网。

use serde::Serialize;
use tauri::State;

use crate::data_store::DataStore;

/// 一条高频序列建议（前端展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSuggestion {
    /// 按出现顺序的动作 id（2~4 步）。
    pub actions: Vec<String>,
    /// 最近 30 天内出现次数。
    pub count: u32,
    /// 该模式最后一次出现时间（YYYY-MM-DD HH:MM:SS）。
    pub last_used: String,
}

/// 程序性记忆：高频动作序列（纯行为统计，无内容）。
#[tauri::command]
pub fn sequence_suggest(store: State<DataStore>) -> Result<Vec<SequenceSuggestion>, String> {
    let pats = store.sequence_mining(30, 3, 4)?;
    Ok(pats
        .into_iter()
        .map(|p| SequenceSuggestion {
            actions: p.actions,
            count: p.count,
            last_used: p.last_used,
        })
        .collect())
}

/// 一条二元转移（前端推荐排序用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceTransitionRow {
    /// 上一个动作 id
    pub from: String,
    /// 紧接着做的动作 id
    pub to: String,
    /// 该转移在统计窗口内出现次数
    pub count: u32,
}

/// 环境智能：二元转移表（“做完 A 你常接着做 B”）。
///
/// 与 `sequence_suggest` 同源同规则，但用途不同：那个是提示用户存成动作链，
/// 这个是嗂给推荐排序。**仍然是纯行为统计，不含任何内容，不出网。**
///
/// 窗口与阈值写死 30 天 / 3 次，与 `sequence_suggest` 一致：
/// 两者取不同窗口的话，会出现“发现面板说你常这么干、推荐却不加分”的矛盾。
#[tauri::command]
pub fn sequence_transitions(store: State<DataStore>) -> Result<Vec<SequenceTransitionRow>, String> {
    let rows = store.sequence_transitions(30, 3)?;
    Ok(rows
        .into_iter()
        .map(|t| SequenceTransitionRow {
            from: t.from,
            to: t.to,
            count: t.count,
        })
        .collect())
}
