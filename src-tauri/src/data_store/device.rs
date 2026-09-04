//! 已配对设备表（M6-P1）。
//!
//! 配对是一次性的**信任建立**；在线与否是连接层事件。两者解耦——
//! 重连只按已存的 `node_id` 重新发现地址，**不重新配对**（设计稿 §6.4）。
//!
//! 只有两种情况需要重新配对：
//! ① 用户在界面上主动「忘记此设备」；
//! ② 本机私钥丢了（换 Windows 账户 / 重装）—— 那时身份变了。

use super::DataStore;
use serde::{Deserialize, Serialize};

/// 一台已配对的设备。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Device {
    /// 对端公钥 hex，主键。
    pub node_id: String,
    pub name: String,
    /// 配对时刻（本地时间字串，与库里其它 `*_at` 同格式）。
    pub paired_at: String,
    /// 最近一次成功握手用的通道：`lan` / `wan` / `""`（还没连上过）。
    pub transport: String,
    /// `online` / `offline`。
    pub conn_state: String,
    /// 最近一次成功握手的 epoch 毫秒；`0` = 从未。
    pub last_seen: i64,
    /// WAN 的 relay 地址，LAN-only 时为空。
    pub relay_addr: String,
}

/// 在线状态的两个取值。用常量而不是散在各处的字面量（规则 #11）。
pub const CONN_ONLINE: &str = "online";
pub const CONN_OFFLINE: &str = "offline";

fn row_to_device(r: &rusqlite::Row) -> rusqlite::Result<Device> {
    Ok(Device {
        node_id: r.get(0)?,
        name: r.get(1)?,
        paired_at: r.get(2)?,
        transport: r.get(3)?,
        conn_state: r.get(4)?,
        last_seen: r.get(5)?,
        relay_addr: r.get(6)?,
    })
}

const COLS: &str = "node_id, name, paired_at, transport, conn_state, last_seen, relay_addr";

impl DataStore {
    /// 配对（或重新配对同一个 `node_id`）。
    ///
    /// ❗ 重复配对**只更新名字与 relay 地址**，不重置 `last_seen` 与 `conn_state`：
    /// 那两个是连接层的事实，不该被一次配对操作抹掉。
    pub fn device_pair(&self, node_id: &str, name: &str, relay_addr: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO devices (node_id, name, paired_at, transport, conn_state, last_seen, relay_addr)
             VALUES (?1, ?2, ?3, '', ?4, 0, ?5)
             ON CONFLICT(node_id) DO UPDATE SET name = ?2, relay_addr = ?5",
            rusqlite::params![node_id, name, super::note::note_now(), CONN_OFFLINE, relay_addr],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 已配对设备，按配对时间倒序。
    pub fn device_list(&self) -> Result<Vec<Device>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(&format!(
                "SELECT {} FROM devices ORDER BY paired_at DESC",
                COLS
            ))
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], row_to_device)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    pub fn device_get(&self, node_id: &str) -> Result<Option<Device>, String> {
        let conn = self.lock_conn();
        match conn.query_row(
            &format!("SELECT {} FROM devices WHERE node_id = ?1", COLS),
            [node_id],
            row_to_device,
        ) {
            Ok(d) => Ok(Some(d)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 忘记此设备。返回是否真的删掉了一行。
    ///
    /// 🔴 这是**唯一**需要对端重新配对的用户操作，界面上必须二次确认。
    pub fn device_forget(&self, node_id: &str) -> Result<bool, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM devices WHERE node_id = ?1", [node_id])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    /// 标记握手成功：置 `online`、记通道与时刻。
    pub fn device_mark_online(
        &self,
        node_id: &str,
        transport: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE devices SET conn_state = ?2, transport = ?3, last_seen = ?4 WHERE node_id = ?1",
            rusqlite::params![node_id, CONN_ONLINE, transport, now_ms],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 标记离线。
    ///
    /// ❗ **不动 `last_seen`**：它的语义是「最后一次在线是什么时候」，
    /// 界面靠它显示「上次在线：3 小时前」。离线时把它刷成现在，那句话就永远是「刚刚」。
    pub fn device_mark_offline(&self, node_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE devices SET conn_state = ?2 WHERE node_id = ?1",
            rusqlite::params![node_id, CONN_OFFLINE],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}
