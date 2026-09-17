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
    /// 上一次会话**实测**走的路径（`lan` / `direct` / `relay`；空串 = 还没连过）。
    ///
    /// 🔴 这是实测值，不是推断。此前设备行只能拿「有没有听到局域网宣告」
    /// 去猜「大概走局域网还是中继」，跨网或组播被拦时必然猜错。
    /// 现在由 `end_session` 从活连接读一次写进来。
    #[serde(default)]
    pub last_path: String,
}

const COLS: &str = "node_id, name, paired_at, conn_state, last_seen, last_path";

fn row_to(r: &rusqlite::Row) -> rusqlite::Result<RcDevice> {
    Ok(RcDevice {
        node_id: r.get(0)?,
        name: r.get(1)?,
        paired_at: r.get(2)?,
        conn_state: r.get(3)?,
        last_seen: r.get(4)?,
        last_path: r.get(5)?,
    })
}

impl DataStore {

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

    /// 记下本次会话**实测**走的路径（`lan` / `direct` / `relay`）。
    ///
    /// 空串会被忽略：`PathKind::None`（一条路都没通）不该覆盖上一次的有效实测，
    /// 否则失败一次就把设备行上的「上次走局域网直连」抹成空白。
    pub fn rc_device_note_path(&self, node_id: &str, path: &str) -> Result<(), String> {
        if path.is_empty() {
            return Ok(());
        }
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE rc_devices SET last_path = ?2 WHERE node_id = ?1",
            rusqlite::params![node_id, path],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> DataStore {
        DataStore::new(":memory:").expect("open store")
    }

    #[test]
    fn new_device_has_empty_last_path() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(d.last_path, "", "还没连过就是空串——不能编一个默认值假装知道");
    }

    #[test]
    fn note_path_roundtrips_and_overwrites() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "relay").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().last_path, "relay");
        // 下一次会话走了局域网直连 → 覆盖旧值
        s.rc_device_note_path("peer-a", "lan").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().last_path, "lan");
    }

    #[test]
    fn empty_path_does_not_overwrite_measured() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "direct").unwrap();
        // `PathKind::None` 落成空串 ⇒ 必须忽略，否则失败一次就抹掉实测值
        s.rc_device_note_path("peer-a", "").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().last_path,
            "direct",
            "空路径（一条路都没通）不该覆盖上一次的有效实测"
        );
    }

    #[test]
    fn device_list_carries_last_path() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "lan").unwrap();
        let list = s.rc_device_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].last_path, "lan", "列表查询的 COLS 必须带上 last_path");
    }
}
