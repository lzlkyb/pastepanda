//! AI 调用明细账。
//!
//! **永远不存内容**：只记 token 数与元信息。存了就等于多一份剪贴板历史，
//! 而且是一份用户不知情、不在主界面里、清不掉的历史。这条红线有测试盯着。
//!
//! 三个容易搞错的取舍：
//! - **失败也记**（`ok = 0`）。不记就对不上账：用户看到服务商后台有 20 次调用，
//!   而这里只有 15 次，会以为统计坏了。
//! - **缓存命中也记**（`cached = 1`，`cost = 0`）。这是直接证明缓存省了多少钱的唯一数据。
//! - **只有真实计费的那些算均价**（`billable`）。把免费的缓存/失败掉进分母会把
//!   单次均价稀释，“还能做 N 次”就会系统性偏大。

use super::*;

/// 明细保留天数。超过就删——用量账的价值在最近几周，不在两年前。
pub const AI_USAGE_RETAIN_DAYS: u32 = 90;

/// 一次 AI 调用的明细。**不含任何内容文本。**
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageEntry {
    /// 动作 id（`ai-translate` 等）；连通性测试记为 `connection-test`。
    pub action_id: String,
    pub provider: String,
    pub model: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// 估算值（美元）。缓存命中与失败都是 0。
    pub cost_usd: f64,
    pub cached: bool,
    pub latency_ms: u64,
    pub ok: bool,
    /// 失败原因（已截断）。成功时为 None。
    pub error: Option<String>,
}

/// 明细行（带 id 与时间，供界面展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageLogRow {
    pub id: i64,
    pub created_at: String,
    #[serde(flatten)]
    pub entry: AiUsageEntry,
}

/// 按天聚合。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageDaily {
    /// `YYYY-MM-DD`
    pub date: String,
    /// 总条数（含缓存命中与失败）
    pub calls: u32,
    /// 真实计费的次数：未命中缓存且成功
    pub billable_calls: u32,
    pub cached_calls: u32,
    pub failed_calls: u32,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
}

/// 按动作聚合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageByAction {
    pub action_id: String,
    pub calls: u32,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 本地日期 `YYYY-MM-DD`。
pub fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// n 天前（含今天共 n 天）的起始时刻字符串。
fn since_str(days: u32) -> String {
    let back = chrono::Duration::days(days.max(1) as i64 - 1);
    (chrono::Local::now() - back)
        .format("%Y-%m-%d 00:00:00")
        .to_string()
}

/// 失败原因的存储上限。服务商的错误体可能很长，没必要整个存进来。
const MAX_ERROR_LEN: usize = 300;

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

impl DataStore {
    /// 记一笔。失败只记日志不往上报：统计写不进去不应该把 AI 功能本身卡死。
    pub fn ai_usage_add(&self, e: &AiUsageEntry) {
        let conn = self.lock_conn();
        let err = e.error.as_deref().map(|s| truncate(s, MAX_ERROR_LEN));
        if let Err(err_db) = conn.execute(
            "INSERT INTO ai_usage_log
                (created_at, action_id, provider, model, prompt_tokens, completion_tokens,
                 cost_usd, cached, latency_ms, ok, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                now_str(),
                e.action_id,
                e.provider,
                e.model,
                e.prompt_tokens,
                e.completion_tokens,
                e.cost_usd,
                e.cached as i32,
                e.latency_ms as i64,
                e.ok as i32,
                err,
            ],
        ) {
            log::warn!("[AI] 用量明细写入失败：{}", err_db);
        }
    }

    /// 某一天的聚合。查不到返回全零而不是报错——“今天还没用过”不是异常。
    pub fn ai_usage_day(&self, date: &str) -> AiUsageDaily {
        let conn = self.lock_conn();
        let row = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN cached = 0 AND ok = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(cached), 0),
                    COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(prompt_tokens), 0),
                    COALESCE(SUM(completion_tokens), 0),
                    COALESCE(SUM(cost_usd), 0)
             FROM ai_usage_log WHERE substr(created_at, 1, 10) = ?1",
            params![date],
            |r| {
                Ok(AiUsageDaily {
                    date: date.to_string(),
                    calls: r.get::<_, i64>(0)? as u32,
                    billable_calls: r.get::<_, i64>(1)? as u32,
                    cached_calls: r.get::<_, i64>(2)? as u32,
                    failed_calls: r.get::<_, i64>(3)? as u32,
                    prompt_tokens: r.get::<_, i64>(4)? as u64,
                    completion_tokens: r.get::<_, i64>(5)? as u64,
                    cost_usd: r.get::<_, f64>(6)?,
                })
            },
        );
        match row {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[AI] 读当日用量失败：{}", e);
                AiUsageDaily {
                    date: date.to_string(),
                    ..Default::default()
                }
            }
        }
    }

    /// 今日聚合。预算判定就走它。
    pub fn ai_usage_today(&self) -> AiUsageDaily {
        self.ai_usage_day(&today_str())
    }

    /// 最近 N 条明细，时间倒序。
    pub fn ai_usage_recent(&self, limit: u32) -> Result<Vec<AiUsageLogRow>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, action_id, provider, model, prompt_tokens,
                        completion_tokens, cost_usd, cached, latency_ms, ok, error
                 FROM ai_usage_log ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit.clamp(1, 500)], |r| {
                Ok(AiUsageLogRow {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    entry: AiUsageEntry {
                        action_id: r.get(2)?,
                        provider: r.get(3)?,
                        model: r.get(4)?,
                        prompt_tokens: r.get::<_, i64>(5)? as u32,
                        completion_tokens: r.get::<_, i64>(6)? as u32,
                        cost_usd: r.get(7)?,
                        cached: r.get::<_, i64>(8)? != 0,
                        latency_ms: r.get::<_, i64>(9)? as u64,
                        ok: r.get::<_, i64>(10)? != 0,
                        error: r.get(11)?,
                    },
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 最近 N 天按天聚合，日期升序。**缺的天不补 0**，由界面决定怎么画。
    pub fn ai_usage_daily(&self, days: u32) -> Result<Vec<AiUsageDaily>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT substr(created_at, 1, 10) AS d,
                        COUNT(*),
                        COALESCE(SUM(CASE WHEN cached = 0 AND ok = 1 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(cached), 0),
                        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(prompt_tokens), 0),
                        COALESCE(SUM(completion_tokens), 0),
                        COALESCE(SUM(cost_usd), 0)
                 FROM ai_usage_log WHERE created_at >= ?1
                 GROUP BY d ORDER BY d ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![since_str(days)], |r| {
                Ok(AiUsageDaily {
                    date: r.get(0)?,
                    calls: r.get::<_, i64>(1)? as u32,
                    billable_calls: r.get::<_, i64>(2)? as u32,
                    cached_calls: r.get::<_, i64>(3)? as u32,
                    failed_calls: r.get::<_, i64>(4)? as u32,
                    prompt_tokens: r.get::<_, i64>(5)? as u64,
                    completion_tokens: r.get::<_, i64>(6)? as u64,
                    cost_usd: r.get::<_, f64>(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 最近 N 天按动作聚合，花费降序——告诉用户钱主要花在哪个动作上。
    pub fn ai_usage_by_action(&self, days: u32) -> Result<Vec<AiUsageByAction>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT action_id, COUNT(*),
                        COALESCE(SUM(prompt_tokens), 0),
                        COALESCE(SUM(completion_tokens), 0),
                        COALESCE(SUM(cost_usd), 0)
                 FROM ai_usage_log WHERE created_at >= ?1
                 GROUP BY action_id ORDER BY SUM(cost_usd) DESC, COUNT(*) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![since_str(days)], |r| {
                Ok(AiUsageByAction {
                    action_id: r.get(0)?,
                    calls: r.get::<_, i64>(1)? as u32,
                    prompt_tokens: r.get::<_, i64>(2)? as u64,
                    completion_tokens: r.get::<_, i64>(3)? as u64,
                    cost_usd: r.get::<_, f64>(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 清空明细。这份账是用户的，必须能一键删掉。
    pub fn ai_usage_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM ai_usage_log", [])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }

    /// 删除超出保留期的明细。启动时跑一次就够。
    pub fn ai_usage_purge(&self, retain_days: u32) -> Result<u32, String> {
        let conn = self.lock_conn();
        let cutoff = (chrono::Local::now() - chrono::Duration::days(retain_days.max(1) as i64))
            .format("%Y-%m-%d 00:00:00")
            .to_string();
        conn.execute("DELETE FROM ai_usage_log WHERE created_at < ?1", params![cutoff])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }
}
