//! data_store/sequence_memory.rs —— 程序性记忆（V3-B）。
//!
//! 从 action_events 挖掘**高频动作序列**：你常「复制报错 → 解释代码 → 提取要点」，
//! 这个重复出现的顺序就是"程序性记忆"——系统记得你惯常的多步操作，
//! 提示把它固化成动作链（M6-4）。
//!
//! 隐私边界（与红线②同构）：
//! - 只统计 action_id 的**顺序模式**，不含任何内容、来源应用、具体时间点；
//! - 只看"你常连着做哪几个动作"，从不看"你对什么内容做了这些动作"。

use std::collections::HashMap;

use rusqlite::params;

use super::DataStore;

/// 一条高频动作序列模式。
#[derive(Debug, Clone)]
pub struct SequencePattern {
    /// 按出现顺序的动作 id（2~4 步）。
    pub actions: Vec<String>,
    /// 最近 N 天内该连续序列出现的次数（重叠窗口计数）。
    pub count: u32,
    /// 该模式最后一次出现的时间（YYYY-MM-DD HH:MM:SS）。
    pub last_used: String,
}

impl DataStore {
    /// 挖掘高频动作序列。
    ///
    /// - `days`：统计窗口（默认 30 天）
    /// - `min_count`：至少出现几次才认为是"习惯"（默认 3）
    /// - `max_steps`：最长序列步数（2~4；X1 规划：超过 5 步难以排错）
    ///
    /// 返回按 count 降序、最多 10 条的模式。
    pub fn sequence_mining(
        &self,
        days: i64,
        min_count: u32,
        max_steps: usize,
    ) -> Result<Vec<SequencePattern>, String> {
        let max_steps = max_steps.clamp(2, 4);
        let since = (chrono::Local::now() - chrono::Duration::days(days.max(1) - 1))
            .format("%Y-%m-%d 00:00:00")
            .to_string();

        let conn = self.lock_conn();
        // 按时间升序取动作序列（排除 paste 哨兵——"粘贴"是动作的结果不是意图）
        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT created_at, action_id FROM action_events
                 WHERE created_at >= ?1 AND action_id != ?2
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?
            .query_map(params![since, crate::data_store::ACTION_ID_PASTE], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let actions: Vec<&str> = rows.iter().map(|(_, a)| a.as_str()).collect();
        if actions.len() < 2 {
            return Ok(vec![]);
        }

        // 滑动窗口统计连续子序列频率（重叠窗口计数，行为序列天然有交叠）
        let mut freq: HashMap<Vec<String>, u32> = HashMap::new();
        for w in 2..=max_steps.min(actions.len()) {
            for i in 0..=actions.len() - w {
                let win = &actions[i..i + w];
                // 跳过全相同窗口（[a,a,a] 是手抖重复，不是习惯模式）
                if win.iter().all(|a| *a == win[0]) {
                    continue;
                }
                let key: Vec<String> = win.iter().map(|s| s.to_string()).collect();
                *freq.entry(key).or_insert(0) += 1;
            }
        }

        let mut out: Vec<SequencePattern> = freq
            .into_iter()
            .filter(|(_, c)| *c >= min_count)
            .map(|(actions, count)| {
                let last_used = find_last_occurrence(&actions, &rows);
                SequencePattern {
                    actions,
                    count,
                    last_used,
                }
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then(b.actions.len().cmp(&a.actions.len())));
        out.truncate(10);
        Ok(out)
    }
}

/// 找 pattern 在事件序列中最后一次出现的时间（倒序匹配，取最早命中）。
fn find_last_occurrence(pattern: &[String], rows: &[(String, String)]) -> String {
    if pattern.is_empty() || rows.len() < pattern.len() {
        return String::new();
    }
    for i in (0..=rows.len() - pattern.len()).rev() {
        let mut matched = true;
        for (k, p) in pattern.iter().enumerate() {
            if rows[i + k].1 != *p {
                matched = false;
                break;
            }
        }
        if matched {
            return rows[i + pattern.len() - 1].0.clone();
        }
    }
    String::new()
}
