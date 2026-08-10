//! 画像原料聚合（M6-2）：从已有表汇总"画像原始数据"。
//!
//! **这里只做数据聚合，不做推断**——角色打分、领域推断、导出格式都在
//! `commands/profile.rs`（业务规则层）。数据层保持"给什么表、出什么统计"的纯粹性。
//!
//! 红线②同构：聚合结果**只有统计值**（动作名 / 内容类型 / 时段），
//! **不含任何内容文本**——画像从原料上就不触碰"用户复制了什么"。

use super::ai_feedback::{ActionPrefRow, AiFeedbackStat};
use super::*;

/// 画像的原始统计数据（30 天窗口）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRawStats {
    /// (action_id, 次数)
    pub action_counts: Vec<(String, u32)>,
    /// (content_type, 次数)
    pub content_type_counts: Vec<(String, u32)>,
    /// (hour, 次数)——用于活跃时段推断
    pub hour_counts: Vec<(i64, u32)>,
    /// AI 结果反馈统计（被改率 → 风格倾向）
    pub feedback: Vec<AiFeedbackStat>,
    /// 动作偏好指令
    pub prefs: Vec<ActionPrefRow>,
    /// 参与统计的动作事件总数（样本量 → 置信度）
    pub total_events: u32,
}

impl DataStore {
    /// 汇总画像原始数据（最近 N 天）。排除 `paste` 哨兵与 abandoned 结果。
    ///
    /// **三条 SQL 的 outcome 过滤必须与 `action_recommend_weights` /
    /// `action_scene_weights` 对齐**（那两个一直有 `outcome IN ('copied','pasted')`，
    /// 只有这里漏了）。漏了的后果在 `abandoned` 真被写入后立即生效：用户
    /// **反复尝试又放弃**的动作会计入 action_counts 抬高角色权重、计入 total_events
    /// 抬高 sample_events / confidence——越放弃，画像越"自信"。
    ///
    /// **另一条不变量**：`action_counts` 与 `hour_counts` 的 WHERE 必须完全一致。
    /// `total_events` 是由 `action_counts` 求和得来的，而命令层算时段百分比时用
    /// `total_events` 做分母、`hour_counts` 做分子——两条 WHERE 一旦错位，
    /// 时段占比之和就不再是 100%。（content_type_counts 多一个 `content_type <> ''`
    /// 是有意的：它单独用 total_ct 做分母，不参与 total_events。）
    pub fn profile_raw_stats(&self, days: u32) -> Result<ProfileRawStats, String> {
        let days = days.clamp(1, 365);
        let since = (chrono::Local::now() - chrono::Duration::days(days.max(1) as i64 - 1))
            .format("%Y-%m-%d 00:00:00")
            .to_string();

        // 三个聚合查询共用一个连接；**必须收进块作用域**——块结束后 conn（MutexGuard）
        // 立即释放，否则后面调 ai_feedback_stats / action_prefs_all（内部再 lock_conn）
        // 会对同一把 std Mutex 二次加锁 → 死锁（std Mutex 不可重入）。
        let (action_counts, content_type_counts, hour_counts) = {
            let conn = self.lock_conn();

            // 动作频率（排除哨兵 + abandoned）
            let action_counts: Vec<(String, u32)> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT action_id, COUNT(*) AS c FROM action_events
                         WHERE created_at >= ?1 AND action_id != ?2
                           AND outcome IN ('copied', 'pasted')
                         GROUP BY action_id ORDER BY c DESC",
                    )
                    .map_err(|e| e.to_string())?;
                let rows: Vec<rusqlite::Result<(String, u32)>> = stmt
                    .query_map(params![since, crate::data_store::ACTION_ID_PASTE], |r| {
                        Ok((r.get(0)?, r.get::<_, i64>(1)? as u32))
                    })
                    .map_err(|e| e.to_string())?
                    .collect();
                rows.into_iter().filter_map(|r| r.ok()).collect()
            };

            // 内容类型分布
            let content_type_counts: Vec<(String, u32)> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT content_type, COUNT(*) AS c FROM action_events
                         WHERE created_at >= ?1 AND action_id != ?2
                           AND outcome IN ('copied', 'pasted')
                           AND content_type <> ''
                         GROUP BY content_type ORDER BY c DESC",
                    )
                    .map_err(|e| e.to_string())?;
                let rows: Vec<rusqlite::Result<(String, u32)>> = stmt
                    .query_map(params![since, crate::data_store::ACTION_ID_PASTE], |r| {
                        Ok((r.get(0)?, r.get::<_, i64>(1)? as u32))
                    })
                    .map_err(|e| e.to_string())?
                    .collect();
                rows.into_iter().filter_map(|r| r.ok()).collect()
            };

            // 时段分布。WHERE 与上面 action_counts **逐字一致**（见函数文档里的不变量）
            let hour_counts: Vec<(i64, u32)> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT hour, COUNT(*) AS c FROM action_events
                         WHERE created_at >= ?1 AND action_id != ?2
                           AND outcome IN ('copied', 'pasted')
                         GROUP BY hour ORDER BY hour",
                    )
                    .map_err(|e| e.to_string())?;
                let rows: Vec<rusqlite::Result<(i64, u32)>> = stmt
                    .query_map(params![since, crate::data_store::ACTION_ID_PASTE], |r| {
                        Ok((r.get(0)?, r.get::<_, i64>(1)? as u32))
                    })
                    .map_err(|e| e.to_string())?
                    .collect();
                rows.into_iter().filter_map(|r| r.ok()).collect()
            };

            (action_counts, content_type_counts, hour_counts)
        };

        let total_events: u32 = action_counts.iter().map(|(_, c)| c).sum();
        let feedback = self.ai_feedback_stats(days)?;
        let prefs = self.action_prefs_all()?;

        Ok(ProfileRawStats {
            action_counts,
            content_type_counts,
            hour_counts,
            feedback,
            prefs,
            total_events,
        })
    }
}
