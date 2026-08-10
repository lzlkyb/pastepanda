//! AI 结果反馈（ai_feedback）+ 动作偏好指令（action_prefs）—— M3 偏好学习。
//!
//! ## ai_feedback —— 用户对 AI 产物的反馈信号
//!
//! **永远不存内容**：只记动作 id、内容类型、结果三态与产物哈希（去重统计用）。
//! 改了什么、删了什么——一个字都不落库（与 action_events / ai_usage_log 同一条红线，
//! 有测试盯着）。存了内容，这条线就变成了用户不知情、清不掉的第二份剪贴板历史。
//!
//! outcome 三态（对应 UI 操作）：
//! - `accepted`：直接复制/粘贴了产物（没改）→ 满意；
//! - `edited`：改过才用 → 不满意信号，`edit_rate` 越高越说明该动作的输出要调；
//! - `rejected`：重新运行/丢弃 → 不满意。
//!
//! ## action_prefs —— 动作级偏好指令
//!
//! 一句话指令（如「译文更简洁」「不要译称呼」），由 ai_run 拼进 system prompt。
//! 数据源：① 用户在「系统学到了什么」里手动写；② 后续版本按 edit_rate 自动建议。
//! 偏好变化会改变输出 → 设置时清 AI 缓存（命令层做）。

use super::*;

/// 审查 backlog：#13 偏好指令最大长度（会拼进每次请求的 system prompt）
const PREF_MAX_CHARS: usize = 500;

/// 反馈保留天数。与 action_events 一致。
pub const AI_FEEDBACK_RETAIN_DAYS: u32 = 90;

pub const FEEDBACK_ACCEPTED: &str = "accepted";
pub const FEEDBACK_EDITED: &str = "edited";
pub const FEEDBACK_REJECTED: &str = "rejected";

/// 一条反馈。**不含内容文本。**
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFeedback {
    pub action_id: String,
    /// 内容类型（`json` / `code` / `text` …），来自 ContentClassifier
    #[serde(default)]
    pub content_type: String,
    /// `accepted` / `edited` / `rejected`
    pub outcome: String,
    /// 产物哈希（简单散列，非加密级）——用于“同款结果被改过几次”的去重统计
    #[serde(default)]
    pub result_hash: String,
}

/// 按动作聚合的反馈统计 ——「哪个 AI 动作的产物最常被改」的数据源。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFeedbackStat {
    pub action_id: String,
    pub total: u32,
    pub accepted: u32,
    pub edited: u32,
    pub rejected: u32,
    /// edited / total，0~1。>0.4 且样本够 → “该动作输出常被改”
    pub edit_rate: f64,
}

/// 一条动作偏好指令（action_prefs 表的一行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPrefRow {
    pub action_id: String,
    pub preference: String,
    pub updated_at: String,
}

impl DataStore {
    /// 记一笔反馈。**写不进去不阻塞**：统计只是记账，不能反过来卡住主流程。
    pub fn ai_feedback_add(&self, fb: &AiFeedback) {
        if !matches!(fb.outcome.as_str(), FEEDBACK_ACCEPTED | FEEDBACK_EDITED | FEEDBACK_REJECTED) {
            return;
        }
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let _ = conn.execute(
            "INSERT INTO ai_feedback (created_at, action_id, content_type, outcome, result_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                now,
                fb.action_id.trim(),
                fb.content_type.trim(),
                fb.outcome,
                fb.result_hash.trim(),
            ],
        );
    }

    /// 按动作聚合的反馈统计（最近 days 天）。
    pub fn ai_feedback_stats(&self, days: u32) -> Result<Vec<AiFeedbackStat>, String> {
        let conn = self.lock_conn();
        let cutoff = chrono::Local::now()
            .checked_sub_signed(chrono::Duration::days(days as i64))
            .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();

        let mut stmt = conn
            .prepare(
                "SELECT action_id,
                        SUM(outcome = 'accepted') AS accepted,
                        SUM(outcome = 'edited')   AS edited,
                        SUM(outcome = 'rejected') AS rejected
                 FROM ai_feedback
                 WHERE created_at >= ?1
                 GROUP BY action_id
                 ORDER BY (edited + rejected) DESC, action_id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&cutoff], |r| {
                let accepted: i64 = r.get(1)?;
                let edited: i64 = r.get(2)?;
                let rejected: i64 = r.get(3)?;
                let total = (accepted + edited + rejected) as u32;
                Ok(AiFeedbackStat {
                    action_id: r.get(0)?,
                    total,
                    accepted: accepted as u32,
                    edited: edited as u32,
                    rejected: rejected as u32,
                    edit_rate: if total == 0 {
                        0.0
                    } else {
                        edited as f64 / total as f64
                    },
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 清过期反馈（启动时跑一次，与 `ai_usage_purge` / `action_event_purge` 同节奏）。
    ///
    /// 红线②的“用户可见可删”不只是给一个清空按钮——**不自动过期就等于永久留存**。
    /// 这张表记的虽然不含内容文本，但“你在哪些动作上反复改过输出”本身就是习惯画像。
    pub fn ai_feedback_purge(&self, retain_days: u32) -> Result<u32, String> {
        let conn = self.lock_conn();
        let cutoff = (chrono::Local::now() - chrono::Duration::days(retain_days.max(1) as i64))
            .format("%Y-%m-%d 00:00:00")
            .to_string();
        conn.execute("DELETE FROM ai_feedback WHERE created_at < ?1", params![cutoff])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }

    /// 一键清空全部反馈（红线②：用户可见可删）。
    pub fn ai_feedback_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM ai_feedback", [])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }

    /// 读某动作的偏好指令（无则空串）。
    pub fn action_pref_get(&self, action_id: &str) -> Result<String, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT preference FROM action_prefs WHERE action_id = ?1",
            params![action_id],
            |r| r.get::<_, String>(0),
        )
        .map(|s| s.trim().to_string())
        .or_else(|_| Ok(String::new()))
    }

    /// 写动作偏好指令。空串 = 清除。
    pub fn action_pref_set(&self, action_id: &str, preference: &str) -> Result<(), String> {
        let action_id = action_id.trim();
        if action_id.is_empty() {
            return Ok(());
        }
        let pref = preference.trim();
        // 审查 backlog：#13 偏好会拼进每次请求的 system prompt，必须限长，否则可膨胀请求体
        if pref.chars().count() > PREF_MAX_CHARS {
            return Err(format!("偏好指令过长（最多 {} 字）", PREF_MAX_CHARS));
        }
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        if pref.is_empty() {
            conn.execute("DELETE FROM action_prefs WHERE action_id = ?1", params![action_id])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO action_prefs (action_id, preference, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(action_id) DO UPDATE SET preference = ?2, updated_at = ?3",
                params![action_id, pref, now],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 全部偏好指令（设置页展示用）。
    pub fn action_prefs_all(&self) -> Result<Vec<ActionPrefRow>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare("SELECT action_id, preference, updated_at FROM action_prefs ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ActionPrefRow {
                    action_id: r.get(0)?,
                    preference: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }
}
