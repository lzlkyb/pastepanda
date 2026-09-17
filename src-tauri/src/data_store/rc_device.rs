//! 远程协助的**已配对设备表**（方案 A）。
//!
//! 与 `devices`（知识库同步）**分开**：配对 = 认出这台机器（共用 NodeIdentity），
//! 同步 / 远程是两种各自授权的信任。一台机器可以只被允许远程、不参与笔记同步，
//! 也可以反过来。

use super::DataStore;
use serde::{Deserialize, Serialize};

/// 一台已授权「可远程本机」的设备。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RcDevice {
    pub node_id: String,
    pub name: String,
    pub paired_at: String,
    /// `online` / `offline`（由 presence 刷新，可空闲时为 offline）。
    #[serde(default)]
    pub conn_state: String,
    #[serde(default)]
    pub last_seen: i64,
}

const COLS: &str = "node_id, name, paired_at, conn_state, last_seen";

fn row_to(r: &rusqlite::Row) -> rusqlite::Result<RcDevice> {
    Ok(RcDevice {
        node_id: r.get(0)?,
        name: r.get(1)?,
        paired_at: r.get(2)?,
        conn_state: r.get(3)?,
        last_seen: r.get(4)?,
    })
}

impl DataStore {
    /// 建表（方案 A：远程配对独立于同步配对）。
    pub fn init_rc_devices_table(conn: &rusqlite::Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS rc_devices (
                 node_id    TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 paired_at  TEXT NOT NULL,
                 conn_state TEXT NOT NULL DEFAULT 'offline',
                 last_seen  INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|e| format!("建 rc_devices 表失败：{}", e))
    }

    /// 配对（或更新名字）。与同步的 `device_pair` 互不影响。
    pub fn rc_device_pair(&self, node_id: &str, name: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO rc_devices (node_id, name, paired_at, conn_state, last_seen)
             VALUES (?1, ?2, ?3, 'offline', 0)
             ON CONFLICT(node_id) DO UPDATE SET name = ?2",
            rusqlite::params![node_id, name, super::note::note_now()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    pub fn rc_device_list(&self) -> Result<Vec<RcDevice>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(&format!(
                "SELECT {} FROM rc_devices ORDER BY paired_at DESC",
                COLS
            ))
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([], row_to).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn rc_device_get(&self, node_id: &str) -> Result<Option<RcDevice>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(&format!("SELECT {} FROM rc_devices WHERE node_id = ?1", COLS))
            .map_err(|e| e.to_string())?;
        let mut rows = st
            .query_map([node_id], row_to)
            .map_err(|e| e.to_string())?;
        rows.next().transpose().map_err(|e| e.to_string())
    }

    pub fn rc_device_forget(&self, node_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM rc_devices WHERE node_id = ?1", [node_id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn rc_device_touch(&self, node_id: &str, online: bool) -> Result<(), String> {
        let conn = self.lock_conn();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE rc_devices SET conn_state = ?2, last_seen = ?3 WHERE node_id = ?1",
            rusqlite::params![
                node_id,
                if online { "online" } else { "offline" },
                if online { now } else { 0i64 }
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}
