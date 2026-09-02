//! MCP 调用审计（W3）。表定义与“为什么不记正文”的理由见 `mod.rs` 建表处。
//!
//! 🔴 红线②：使用日志永不出本机，且用户**可见可删**。
//! 所以这里必须同时提供「看」（`mcp_audit_list` / `mcp_audit_clients`）
//! 与「删」（`mcp_audit_clear` / `mcp_audit_purge_expired`），缺一个都不成立。

use serde::Serialize;

use super::note::{expired_cutoff, note_now};
use super::DataStore;

/// 一条调用记录。
#[derive(Debug, Clone, Serialize)]
pub struct McpAuditRow {
    pub id: i64,
    pub at: String,
    pub client: String,
    pub tool: String,
    pub args: String,
    pub ok: bool,
    pub hit_count: i64,
    /// 逗号分隔的笔记 id。前端展示时可以拿它去跳转。
    pub note_ids: String,
}

/// 客户端花名册的一行。**不是存出来的，是从审计表聚合出来的。**
#[derive(Debug, Clone, Serialize)]
pub struct McpClientRow {
    pub client: String,
    pub first_seen: String,
    pub last_seen: String,
    pub calls: i64,
}

impl DataStore {
    /// 记一条。**返回 `Result` 而不是吞掉错误**：调用方（MCP server）要拿它
    /// 决定是否向用户报「审计断过」。已拍板 fail-open（写不下也照常服务），
    /// 但**必须让用户看见**——静默地丢审计等于审计不可信。
    pub fn mcp_audit_log(
        &self,
        client: &str,
        tool: &str,
        args: &str,
        ok: bool,
        hit_count: i64,
        note_ids: &[String],
    ) -> Result<(), String> {
        self.lock_conn()
            .execute(
                "INSERT INTO mcp_audit (at, client, tool, args, ok, hit_count, note_ids)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    note_now(),
                    client,
                    tool,
                    args,
                    i64::from(ok),
                    hit_count,
                    note_ids.join(","),
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// 最近的调用，时间倒序。
    pub fn mcp_audit_list(&self, limit: u32) -> Result<Vec<McpAuditRow>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, at, client, tool, args, ok, hit_count, note_ids
                 FROM mcp_audit ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(McpAuditRow {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    client: r.get(2)?,
                    tool: r.get(3)?,
                    args: r.get(4)?,
                    ok: r.get::<_, i64>(5)? != 0,
                    hit_count: r.get(6)?,
                    note_ids: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 客户端花名册。从审计表聚合——不单开一张表去维护第二份真相。
    ///
    /// 注意它回答不了「当前连着几个」——HTTP 无状态，根本没有「连着」这回事。
    /// 界面上只能说「最近活动过的客户端」。
    pub fn mcp_audit_clients(&self) -> Result<Vec<McpClientRow>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT client, MIN(at), MAX(at), COUNT(*) FROM mcp_audit
                 GROUP BY client ORDER BY MAX(at) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(McpClientRow {
                    client: r.get(0)?,
                    first_seen: r.get(1)?,
                    last_seen: r.get(2)?,
                    calls: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn mcp_audit_count(&self) -> i64 {
        self.lock_conn()
            .query_row("SELECT COUNT(*) FROM mcp_audit", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// 清空。红线②的「可删」就靠它。
    pub fn mcp_audit_clear(&self) -> Result<usize, String> {
        self.lock_conn()
            .execute("DELETE FROM mcp_audit", [])
            .map_err(|e| e.to_string())
    }

    /// 清理超期记录。`days <= 0` = 用户关了自动清理，直接返回 0。
    ///
    /// 截止时间复用 `note::expired_cutoff`：它与 `note_now()` 同一个格式常量，
    /// 而本表的 `at` 也是 `note_now()` 写的——两边格式必须一致，否则字符串
    /// 比较会在边界上错（同 note.rs 那条注释里的理由）。
    pub fn mcp_audit_purge_expired(&self, days: i64) -> Result<usize, String> {
        let Some(cutoff) = expired_cutoff(days) else {
            return Ok(0);
        };
        self.lock_conn()
            .execute("DELETE FROM mcp_audit WHERE at < ?1", [&cutoff])
            .map_err(|e| e.to_string())
    }
}
