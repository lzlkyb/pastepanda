//! 待沉淀区（知识库 A 阶段 · 规划 §8.1 4️⃣，设计稿 §5）。
//!
//! **它是虚拟视图，不是队列表。** 整个文件只有一个写入动作（`kb_inbox_dismiss`，
//! 用户点「忽略」才走）。候选集全靠一条 SQL 实时算出——**无后台写入就无噪音写入**，
//! 也就不需要任何清理任务：取消收藏 / 已转笔记 / 卡片被删，候选自然消失。
//!
//! 🔴 红线：无 AI。不读内容做任何判断，只数信号。

use super::history::{row_to_history_item, HISTORY_COLS};
use super::*;

/// 一条待沉淀候选。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxCandidate {
    /// 原卡片。直接给前端复用卡片渲染能力（文本预览 / 来源 / 时间）。
    pub item: HistoryItem,
    /// 入选原因：`star`（收藏）/ `research`（找回）。
    ///
    /// 在后端算而不是让前端从 `pinned`/`hit` 推：忽略时要把它写进
    /// `kb_inbox_dismissed.reason`，两边各算一遍就会漂。
    pub reason: String,
    /// 被搜索命中次数。主排序依据，也是展示文案的数字。
    pub search_hit_count: i64,
    /// 是否有过 `action_events.outcome='pasted'`。
    ///
    /// 只做同分时的 tiebreaker（`↩A-28`）：它语义最准（真的被取用了），
    /// 但只覆盖热键类用法，**不能当候选源**。
    pub recently_pasted: bool,
}

/// 候选条件。抽出成常量：列表与计数必须用**完全相同**的条件，
/// 否则横幅上写「待沉淀 225 条」而列表里只有 200 条，用户会以为丢了东西。
///
/// 两个信号（规划 §1.6 通路 #1 #2）+ 两个排除：
/// - 通路#1 `pinned = 1`——**实测为 0**（§3.2），不删是因为零成本且用了就是强意图；
/// - 通路#2 `search_hit_count >= 2`——**存量就有 225 条**，所以必须分批；
/// - 排除已有笔记、排除用户说过「别烦我」的。
const CANDIDATE_WHERE: &str = "
    WHERE h.workspace = ?1
      AND (h.pinned = 1 OR COALESCE(h.search_hit_count, 0) >= 2)
      AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.history_id = h.id)
      AND NOT EXISTS (SELECT 1 FROM kb_inbox_dismissed d WHERE d.history_id = h.id)";

impl DataStore {
    /// 待沉淀候选列表（分批）。
    ///
    /// 排序：`search_hit_count` 降序（最强信号优先）→ 同分时有 `pasted` 的往前
    /// （`↩A-28`）→ 再同分按时间倒序。最后那道是为了**结果稳定**：
    /// 不加的话同分行的相对顺序由 SQLite 自由安排，分页时会出现同一条重复 / 跌页。
    pub fn kb_inbox_list(
        &self,
        workspace: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<InboxCandidate>, String> {
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT {cols},
                    COALESCE(h.search_hit_count, 0) AS hit,
                    EXISTS(SELECT 1 FROM action_events ae
                            WHERE ae.history_id = h.id AND ae.outcome = 'pasted') AS pasted
             FROM history h
             {where_clause}
             ORDER BY hit DESC, pasted DESC, h.time DESC
             LIMIT ?2 OFFSET ?3",
            // 列名带 h. 前缀：子查询里也有 history_id 同名列，不限定会歧义
            cols = HISTORY_COLS
                .split(", ")
                .map(|c| format!("h.{c}"))
                .collect::<Vec<_>>()
                .join(", "),
            where_clause = CANDIDATE_WHERE,
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Vec<InboxCandidate> = stmt
            .query_map(rusqlite::params![workspace, limit, offset], |row| {
                let item = row_to_history_item(row)?;
                // 13 列之后才是我们额外选的两列
                let hit: i64 = row.get(13)?;
                let pasted: i64 = row.get(14)?;
                let reason = if item.pinned { "star" } else { "research" };
                Ok(InboxCandidate {
                    reason: reason.to_string(),
                    search_hit_count: hit,
                    recently_pasted: pasted != 0,
                    item,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 候选总数（横幅计数）。与 `kb_inbox_list` 共用 `CANDIDATE_WHERE`。
    pub fn kb_inbox_count(&self, workspace: &str) -> Result<i64, String> {
        let conn = self.lock_conn();
        let sql = format!("SELECT COUNT(*) FROM history h {CANDIDATE_WHERE}");
        conn.query_row(&sql, [workspace], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    /// 忽略一条候选（本文件**唯一**的写入）。
    ///
    /// 整卡粒度：「这条别烦我」比「这个信号别烦我」更符合直觉（设计稿 §5-3）。
    /// 用 `INSERT OR REPLACE` 而不是 `INSERT`：同一张卡片可能先因找回入选被忽略，
    /// 后来又因收藏重新入选（用户手动取消了 dismiss 才会），`reason` 取最后一次。
    pub fn kb_inbox_dismiss(&self, history_id: &str, reason: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR REPLACE INTO kb_inbox_dismissed (history_id, reason, created_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                history_id,
                reason,
                // 全库时间戳惯例（action_events.rs:169 等处同形）。不用 note.rs 里的毫秒版：
                // 那里加毫秒是为了笔记列表排序稳定，而这张表从不按时间排序
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 恢复一条被忽略的候选（忽略的撤销）。
    ///
    /// 为何需要它：忽略是单击就生效的，而候选行上两个按钮靠得很近。
    /// 没有回头路的话，一次误点就把那张卡片永久逐出了待沉淀区，而用户无从发现。
    pub fn kb_inbox_undismiss(&self, history_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM kb_inbox_dismissed WHERE history_id = ?1",
            [history_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
