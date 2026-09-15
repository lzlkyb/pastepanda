//! 远程协助的「邀请门」+ 敲门队列（方案 A）。
//!
//! 与 `sync::join` 同构，但是**独立的一扇门**：远程配对不依赖同步配对。
//! 生成 RC 邀请码 = 开门；门开着时陌生对端的 Request 记成待确认，用户核对指纹后
//! 写入 `rc_devices`。

use crate::data_store::DataStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 配置键：RC 邀请门开到什么时候（epoch 毫秒）。
pub const CFG_DOOR_UNTIL: &str = "rc_invite_open_until";

/// 一条 RC 敲门（对方想配对以便远程，或首次连上）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RcJoinRequest {
    pub node_id: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub tries: u32,
}

const KNOCK_TTL_MS: i64 = 10 * 60 * 1000;
/// 拒绝配对后的冷却：到点自动允许再敲门，避免一次误拒永久锁死。
const DENY_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Default)]
pub struct RcJoins {
    pending: Mutex<HashMap<String, RcJoinRequest>>,
    /// node_id → 拒绝生效到什么时候（epoch ms）。
    denied: Mutex<HashMap<String, i64>>,
}

impl RcJoins {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn is_denied(&self, node_id: &str, now_ms: i64) -> bool {
        let Ok(d) = self.denied.lock() else {
            return false;
        };
        matches!(d.get(node_id), Some(&until) if now_ms < until)
    }

    pub fn knock(&self, node_id: &str, now_ms: i64) -> bool {
        if node_id.is_empty() {
            return false;
        }
        if self.is_denied(node_id, now_ms) {
            return false;
        }
        let Ok(mut m) = self.pending.lock() else {
            return false;
        };
        m.entry(node_id.to_string())
            .and_modify(|r| {
                r.last_seen_ms = now_ms;
                r.tries += 1;
            })
            .or_insert(RcJoinRequest {
                node_id: node_id.to_string(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                tries: 1,
            });
        true
    }

    pub fn list(&self, now_ms: i64) -> Vec<RcJoinRequest> {
        let Ok(mut m) = self.pending.lock() else {
            return Vec::new();
        };
        m.retain(|_, r| now_ms - r.last_seen_ms <= KNOCK_TTL_MS);
        let mut v: Vec<RcJoinRequest> = m.values().cloned().collect();
        v.sort_by_key(|r| r.first_seen_ms);
        v
    }

    pub fn take(&self, node_id: &str) -> bool {
        self.pending
            .lock()
            .map(|mut m| m.remove(node_id).is_some())
            .unwrap_or(false)
    }

    pub fn deny(&self, node_id: &str, now_ms: i64) {
        self.take(node_id);
        if let Ok(mut d) = self.denied.lock() {
            d.insert(node_id.to_string(), now_ms + DENY_TTL_MS);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut m) = self.pending.lock() {
            m.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_blocks_then_expires() {
        let j = RcJoins::new();
        let now = 1_000_000i64;
        assert!(j.knock("peer", now));
        j.deny("peer", now);
        assert!(!j.knock("peer", now), "刚拒绝应挡住再敲门");
        assert!(j.knock("peer", now + DENY_TTL_MS + 1), "冷却结束后应允许");
    }

    #[test]
    fn knock_records_pending() {
        let j = RcJoins::new();
        let now = 5_000i64;
        assert!(j.knock("a", now));
        assert!(j.knock("a", now + 1), "重复敲门应刷新而不是失败");
        let list = j.list(now + 1);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].tries, 2);
        assert!(j.take("a"));
        assert!(j.list(now + 1).is_empty());
    }
}

/// 邀请门是否还开着。
pub fn door_open(store: &DataStore, now_ms: i64) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| {
            c.get(CFG_DOOR_UNTIL)
                .and_then(|v| v.as_i64())
        })
        .map(|until| now_ms < until)
        .unwrap_or(false)
}

/// 开门（生成邀请码时调用）。
pub fn open_door(store: &DataStore, until_ms: i64) -> Result<(), String> {
    let mut config = store.get_config()?;
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象")?;
    obj.insert(
        CFG_DOOR_UNTIL.to_string(),
        serde_json::Value::from(until_ms),
    );
    store.save_config(&config)
}
