//! 内容记忆（M5-1，纯本地）：为剪贴板历史生成「检索摘要」并持久化。
//!
//! **这是「你处理过什么」的记忆层，但绝不新增对内容的存储**：
//! 历史原文本来就在 `history` 表（剪贴板管理器自带的职责）。本模块只做
//! **提炼**——从原文抽 URL 域名、邮箱与正文开头，形成一行摘要，供：
//! ① 搜索增强（LIKE 回退路径多一路「摘要命中」，「上周那个 API 文档」这类
//!    凭印象的搜索更容易命中）；
//! ② 后续内容级周报 / 意图识别的地基（M5-2）。
//!
//! 隐私自检（与红线②同构）：
//! - 摘要**只在本机**（`history_summaries` 表），绝不外发（云端语义是 M5-2，
//!   需授权开关）；
//! - 用户可见可删：清空后**不自动补存量**（删了就是删了），新条目才继续记；
//! - 敏感内容（`is_secret`）**不生成摘要**——密钥的「指纹」也不该留下。

use super::*;
use std::sync::OnceLock;

/// URL 域名（去 www.）。仅匹配 http/https。
fn extract_domains(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for cap in url_re().captures_iter(text) {
        if let Some(host) = cap.get(1) {
            let h = host.as_str().trim().to_lowercase();
            let h = h.strip_prefix("www.").unwrap_or(&h).to_string();
            if !h.is_empty() && !out.contains(&h) {
                out.push(h);
            }
        }
    }
    out.truncate(3);
    out
}

/// 提取邮箱（去重，最多 2 个）
fn extract_emails(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for cap in email_re().captures_iter(text) {
        let e = cap.get(0).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        if !e.is_empty() && !out.contains(&e) {
            out.push(e);
        }
    }
    out.truncate(2);
    out
}

/// 正文开头（去空白压缩，最多 80 字符）——保留「这段话大概在讲什么」的痕迹
fn body_head(text: &str) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(80).collect()
}

/// 从文本生成检索摘要（纯规则、零 LLM、可测）。
/// 输出格式：`域名：a.com b.com；邮箱：x@y.com；正文：...`（无信息的部分省略）。
pub fn summarize_text(text: &str) -> String {
    let mut parts: Vec<String> = vec![];
    let domains = extract_domains(text);
    if !domains.is_empty() {
        parts.push(format!("域名：{}", domains.join(" ")));
    }
    let emails = extract_emails(text);
    if !emails.is_empty() {
        parts.push(format!("邮箱：{}", emails.join(" ")));
    }
    let body = body_head(text);
    if !body.is_empty() {
        parts.push(format!("正文：{}", body));
    }
    parts.join("；")
}

/// 一条内容记忆摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub history_id: String,
    pub summary: String,
    pub created_at: String,
}

/// URL 正则（粗匹配，够提取域名）
fn url_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"https?://(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})").unwrap()
    })
}

/// 邮箱正则
fn email_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

impl DataStore {
    /// 读某条历史的摘要（没有返回空串）。
    pub fn history_summary(&self, id: &str) -> Result<String, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT summary FROM history_summaries WHERE history_id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .map(|s| s.trim().to_string())
        .or_else(|_| Ok(String::new()))
    }

    /// 为一条历史生成并保存摘要（幂等 upsert）。
    /// **敏感内容不记**（密钥的指纹也不留）；空摘要（无可提炼信息）不存。
    pub fn history_summary_ensure(&self, id: &str, text: &str) -> Result<(), String> {
        let classifier = crate::content_classifier::ContentClassifier::new();
        if classifier.is_secret(text) {
            return Ok(());
        }
        let summary = summarize_text(text);
        if summary.is_empty() {
            return Ok(());
        }
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO history_summaries (history_id, summary, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(history_id) DO UPDATE SET summary = ?2",
            params![id, summary, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 存量回填（启动时懒跑）：给还没有摘要的历史补一份。
    /// **只回填一次**：config 标记 `content_memory_backfilled` 置位后（含清空后）
    /// 不再自动补存量（红线②：删了就是删了），新条目仍会在插入时继续记。
    pub fn history_summaries_backfill(&self, limit: i64) -> Result<u32, String> {
        let conn = self.lock_conn();
        // config.value 是 TEXT，用 String 读
        let marked: String = conn
            .query_row(
                "SELECT value FROM config WHERE key = 'content_memory_backfilled'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        if marked == "1" {
            return Ok(0);
        }

        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT h.id, h.text FROM history h
                 LEFT JOIN history_summaries s ON s.history_id = h.id
                 WHERE s.history_id IS NULL AND h.type = 'text' AND h.text <> ''
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?
            .query_map([limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut n = 0u32;
        for (id, text) in rows {
            let classifier = crate::content_classifier::ContentClassifier::new();
            if classifier.is_secret(&text) {
                continue;
            }
            let summary = summarize_text(&text);
            if summary.is_empty() {
                continue;
            }
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO history_summaries (history_id, summary, created_at)
                 VALUES (?1, ?2, ?3)",
                params![id, summary, now],
            );
            n += 1;
        }
        // 置位"已回填过"（此后不再自动补存量）
        let _ = conn.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('content_memory_backfilled', '1')",
            [],
        );
        Ok(n)
    }

    /// 内容记忆条目数（设置页展示用）。
    pub fn history_summaries_count(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.query_row("SELECT COUNT(*) FROM history_summaries", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
    }

    /// 一键清空内容记忆。**删了不自动补存量**（新条目继续记）。
    pub fn history_summaries_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM history_summaries", [])
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    }
}
