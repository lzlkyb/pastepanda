//! 会话历史记录（Tier B 从 `service.rs` 拆出）。
//!
//! 只记元数据：谁 / 方向 / 能力 / 时长 / 结果。不记画面与键鼠。
//! 纯搬位置 + 收口，存储键、截断上限、时序一律不变。

use crate::data_store::DataStore;
use serde_json::Value;
use super::protocol::{Capability, SessionPhase};

/// 会话历史的存储键（存进 `config` JSON 的顶层字段）。
pub(super) const KEY: &str = "rc_session_history";
/// 最多保留最近多少条历史。
pub(super) const MAX: usize = 20;

/// 只记元数据：谁 / 方向 / 能力 / 时长 / 结果。不记画面与键鼠。
pub(super) fn append_history(
    store: &DataStore,
    peer: &str,
    peer_name: &str,
    cap: Capability,
    phase: SessionPhase,
    started_ms: i64,
    reason: &str,
) {
    let ended = super::service::now_ms();
    let dir = match phase {
        SessionPhase::OutboundActive | SessionPhase::OutboundPending => "outbound",
        _ => "inbound",
    };
    let entry = serde_json::json!({
        "peer": peer,
        "peer_name": peer_name,
        "capability": cap.as_str(),
        "dir": dir,
        "started_ms": started_ms,
        "ended_ms": ended,
        "duration_ms": (ended - started_ms).max(0),
        "reason": reason,
    });
    let mut config = store.get_config().unwrap_or_default();
    let Some(obj) = config.as_object_mut() else { return };
    let mut list: Vec<Value> = obj
        .get(KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    list.insert(0, entry);
    list.truncate(MAX);
    if let Ok(v) = serde_json::to_value(&list) {
        obj.insert(KEY.to_string(), v);
        let _ = store.save_config(&config);
    }
}

/// 读最近若干条会话历史（前端展示用）。
pub(super) fn list_history(store: &DataStore) -> Vec<Value> {
    store
        .get_config()
        .unwrap_or_default()
        .get(KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_store::DataStore;

    fn temp_store() -> DataStore {
        DataStore::new(":memory:").expect("open store")
    }

    #[test]
    fn append_then_list_roundtrips_and_caps_at_max() {
        let store = temp_store();
        for i in 0..(MAX as i64 + 5) {
            append_history(
                &store,
                &format!("peer{i}"),
                &format!("name{i}"),
                Capability::View,
                SessionPhase::OutboundActive,
                i,
                "test",
            );
        }
        let list = list_history(&store);
        // 截断到 MAX
        assert_eq!(list.len(), MAX);
        // 最新一条在最前，且是最后写入的那条（peer 最大）
        assert_eq!(list[0]["peer"], format!("peer{}", MAX as i64 + 4));
        assert_eq!(list[0]["dir"], "outbound");
        assert_eq!(list[0]["reason"], "test");
    }

    #[test]
    fn inbound_phase_records_inbound_dir() {
        let store = temp_store();
        append_history(
            &store,
            "p",
            "n",
                Capability::View,
                SessionPhase::InboundActive,
            100,
            "kicked",
        );
        let list = list_history(&store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["dir"], "inbound");
        // duration = 落库时的 ended_ms - started_ms，不依赖再次读钟（避免 ±1ms 抖动）。
        let ended = list[0]["ended_ms"].as_i64().unwrap();
        assert_eq!(list[0]["duration_ms"], ended - 100);
        assert!(list[0]["duration_ms"].as_i64().unwrap() >= 0);
    }
}
