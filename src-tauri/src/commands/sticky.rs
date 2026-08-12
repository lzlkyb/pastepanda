//! 粘性数据命令（v6.8）：一次取回活跃轨迹 + 成就 + 里程碑原料。
//!
//! 纯本地只读聚合，不出网、不含内容；前端负责展示与本地"已读"状态。

use tauri::State;
use crate::data_store::{DataStore, StickyStats};

/// 粘性数据总览（活跃日历 / 连续周数 / 成就判定 / 里程碑原料）。
#[tauri::command]
pub fn stats_sticky(store: State<DataStore>) -> Result<StickyStats, String> {
    Ok(store.sticky_stats())
}
