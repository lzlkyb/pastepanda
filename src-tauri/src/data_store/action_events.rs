//! 动作使用日志（action_events）——v6.0 起，一切「学习」能力的燃料。
//!
//! **永远不存内容**：只记动作 id、内容类型、来源应用、时段与结果。
//! 存了就等于多一份剪贴板历史，而且是一份用户不知情、不在主界面里、
//! 清不掉的历史——这条红线与 `ai_usage.rs` 完全一致，有测试盯着。
//!
//! 三个容易搞错的取舍：
//! - **outcome 只有三种**：`copied` / `pasted` / `abandoned`。
//!   复制 = 内容有用；粘贴 = 内容真正被用上；abandoned = 看到了但没用
//!   （v6.1 起由枢纽关闭事件补记）。v6.0 先记前两种，正是路线图建议的第一步。
//! - **记录的是「动作选择」**，不是文本本身，也不是动作的产出。
//! - **写不进去不阻塞**：动作照常返回，统计只是记账，不能反过来卡住主流程。
//!
//! v6.1 起这张表还承担两件事：
//! - **个性化权重**：按 (action_id × content_type) 聚合使用频次，前端算「个人排序权重」；
//! - **粘贴信号回写**：主列表粘贴记 `action_id = "paste"` 的哨兵事件（带 `history_id`），
//!   是「按价值清理」（自我净化）的关键输入。聚合权重时必须排除这个哨兵。

use super::*;

/// 事件保留天数。学习价值集中在最近几周，90 天足够。
pub const ACTION_EVENTS_RETAIN_DAYS: u32 = 90;

/// 粘贴信号回写的哨兵动作 id（不是真实变换动作，聚合权重时排除）。
pub const ACTION_ID_PASTE: &str = "paste";

/// outcome 取值。写死字符串而不是枚举，便于 SQL 直接 GROUP BY 与后续扩展。
pub const OUTCOME_COPIED: &str = "copied";
pub const OUTCOME_PASTED: &str = "pasted";
pub const OUTCOME_ABANDONED: &str = "abandoned";

/// 一次动作事件。**不含任何内容文本。**
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEvent {
    /// 动作 id（`sql-in` / `ai-translate` / 自定义动作 id / `paste` 哨兵 …）
    pub action_id: String,
    /// 内容类型（`json` / `code` / `text` …），来自 ContentClassifier
    pub content_type: String,
    /// 来源应用（SOURCE_MAP 规范化后的应用名），空串表示未知
    pub source_app: String,
    /// 0–23，时段特征。前端按本机时间算好传入
    pub hour: i32,
    /// `copied` / `pasted` / `abandoned`
    pub outcome: String,
    /// 关联的历史条目 id。粘贴回写必填，动作事件可空（v6.1 新增列，老数据为 NULL）
    #[serde(default)]
    pub history_id: Option<String>,
}

/// 按动作聚合的计数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEventCount {
    pub action_id: String,
    pub count: u32,
}

/// 一段时间的事件统计——「系统学到了什么」（红线②）的数据源。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEventStats {
    pub days: u32,
    pub total: u32,
    pub copied: u32,
    pub pasted: u32,
    pub abandoned: u32,
    /// 使用最多的动作，按次数降序。
    pub top_actions: Vec<ActionEventCount>,
}

/// 个性化权重的一行：某内容类型下某动作的使用频次（copied + pasted）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionWeightRow {
    pub action_id: String,
    pub content_type: String,
    pub count: u32,
}

/// 一条「不再推荐这个」负反馈（v6.1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDismissal {
    pub action_id: String,
    /// 空串表示「这个动作在哪儿都不推荐」；否则只在该内容类型下不推荐
    pub content_type: String,
    pub created_at: String,
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

impl DataStore {
    /// 记一笔。失败只记日志不往上报：统计写不进去不应该卡住动作本身。
    pub fn action_event_add(&self, e: &ActionEvent) {
        let conn = self.lock_conn();
        if let Err(err_db) = conn.execute(
            "INSERT INTO action_events
                (created_at, action_id, content_type, source_app, hour, outcome, history_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                now_str(),
                e.action_id,
                e.content_type,
                e.source_app,
                e.hour,
                e.outcome,
                e.history_id,
            ],
        ) {
            log::warn!("[ActionEvents] 事件写入失败：{}", err_db);
        }
    }

    /// 最近 N 天的统计。查不到返回全零而不是报错——「还没用过」不是异常。
    pub fn action_event_stats(&self, days: u32) -> ActionEventStats {
        let conn = self.lock_conn();
        let days = days.clamp(1, 365);
        let since = (chrono::Local::now() - chrono::Duration::days(days.max(1) as i64 - 1))
            .format("%Y-%m-%d 00:00:00")
            .to_string();

        let base = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN outcome = 'copied' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN outcome = 'pasted' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END), 0)
                 FROM action_events WHERE created_at >= ?1",
                params![since],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)? as u32,
                        r.get::<_, i64>(1)? as u32,
                        r.get::<_, i64>(2)? as u32,
                        r.get::<_, i64>(3)? as u32,
                    ))
                },
            )
            .unwrap_or((0, 0, 0, 0));

        let mut stmt = match conn.prepare(
            "SELECT action_id, COUNT(*) AS c FROM action_events
             WHERE created_at >= ?1
             GROUP BY action_id ORDER BY c DESC, action_id ASC
             LIMIT 10",
        ) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[ActionEvents] 统计查询失败：{}", e);
                return ActionEventStats {
                    days,
                    total: base.0,
                    copied: base.1,
                    pasted: base.2,
                    abandoned: base.3,
                    ..Default::default()
                };
            }
        };
        let top: Vec<ActionEventCount> = stmt
            .query_map(params![since], |r| {
                Ok(ActionEventCount {
                    action_id: r.get(0)?,
                    count: r.get::<_, i64>(1)? as u32,
                })
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();

        ActionEventStats {
            days,
            total: base.0,
            copied: base.1,
            pasted: base.2,
            abandoned: base.3,
            top_actions: top,
        }
    }

    /// 清空全部事件。学习日志是用户的，必须能一键删掉（红线②）。
    pub fn action_event_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM action_events", [])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }

    /// 个性化权重数据：按 (action_id × content_type) 聚合近 N 天的使用频次。
    ///
    /// - 只统计 `copied` + `pasted`（abandoned 是"看过没用"，不该加权）；
    /// - **排除 `paste` 哨兵**：那是粘贴信号回写，不是变换动作，混进权重会把
    ///   "粘贴很多"误当成"这个动作常用"；
    /// - 返回空表不是错误——数据不足时前端走冷启动（退回静态分）。
    pub fn action_recommend_weights(&self, days: u32) -> Vec<ActionWeightRow> {
        let conn = self.lock_conn();
        let days = days.clamp(1, 365);
        let since = (chrono::Local::now() - chrono::Duration::days(days.max(1) as i64 - 1))
            .format("%Y-%m-%d 00:00:00")
            .to_string();

        let mut stmt = match conn.prepare(
            "SELECT action_id, content_type, COUNT(*) AS c
             FROM action_events
             WHERE created_at >= ?1
               AND action_id != ?2
               AND outcome IN ('copied', 'pasted')
             GROUP BY action_id, content_type
             ORDER BY c DESC",
        ) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[ActionEvents] 权重聚合查询失败：{}", e);
                return Vec::new();
            }
        };
        stmt.query_map(params![since, ACTION_ID_PASTE], |r| {
            Ok(ActionWeightRow {
                action_id: r.get(0)?,
                content_type: r.get(1)?,
                count: r.get::<_, i64>(2)? as u32,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// 记一条「不再推荐这个」。(action_id, content_type) 重复记会被主键吞掉（幂等）。
    /// content_type 传空串 = 这个动作在哪儿都不推荐。
    pub fn action_dismiss_add(&self, action_id: &str, content_type: &str) {
        let conn = self.lock_conn();
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO action_dismissals (action_id, content_type, created_at)
             VALUES (?1, ?2, ?3)",
            params![action_id, content_type, now_str()],
        ) {
            log::warn!("[ActionEvents] 写入负反馈失败：{}", e);
        }
    }

    /// 全部负反馈列表。
    pub fn action_dismissals(&self) -> Result<Vec<ActionDismissal>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT action_id, content_type, created_at FROM action_dismissals
                 ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ActionDismissal {
                    action_id: r.get(0)?,
                    content_type: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 清空负反馈（配合「清空学习记录」一起用）。
    pub fn action_dismissals_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM action_dismissals", [])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }

    /// 删除超出保留期的事件。启动时跑一次就够。
    pub fn action_event_purge(&self, retain_days: u32) -> Result<u32, String> {
        let conn = self.lock_conn();
        let cutoff = (chrono::Local::now() - chrono::Duration::days(retain_days.max(1) as i64))
            .format("%Y-%m-%d 00:00:00")
            .to_string();
        conn.execute(
            "DELETE FROM action_events WHERE created_at < ?1",
            params![cutoff],
        )
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
    }
}
