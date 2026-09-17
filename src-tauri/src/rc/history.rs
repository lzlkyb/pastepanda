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

/// 一条会话历史的事实来源（由收口方填）。
///
/// 🔴 收成结构体不是好看：本函数原本就有 7 个参数（clippy 阈值上限），
///    再加链路信息就会触发 `too_many_arguments`。而且这几个字段里有
///    三个 `&str`（`peer` / `peer_name` / `reason`）——位置参数传反了
///    编译器**不报错**，只会把记录写歪。
pub(super) struct HistoryFacts<'a> {
    pub peer: &'a str,
    pub peer_name: &'a str,
    pub cap: Capability,
    pub phase: SessionPhase,
    pub started_ms: i64,
    pub reason: &'a str,
    /// 本次会话**实测**的路径与网速摘要（来自 `LinkState::detach`）。
    pub end: super::link::LinkEnd,
}

/// 只记元数据：谁 / 方向 / 能力 / 时长 / 结果 / **走哪条路 + 网速摘要**。
/// 不记画面与键鼠。
pub(super) fn append_history(store: &DataStore, facts: HistoryFacts<'_>) {
    let HistoryFacts {
        peer,
        peer_name,
        cap,
        phase,
        started_ms,
        reason,
        end,
    } = facts;
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
        // 路径与网速摘要：留空/留 0 表示这次没测到（旧记录也没有这几个字段，
        // 前端一律按「没有」处理，不做默认值推断）。
        "path_kind": end.path.as_str(),
        "rtt_min": end.rtt_min,
        "rtt_avg": end.rtt_avg,
        "rtt_max": end.rtt_max,
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
    use crate::rc::link::LinkEnd;
    use crate::sync::path_kind::PathKind;

    fn temp_store() -> DataStore {
        DataStore::new(":memory:").expect("open store")
    }

    /// 造一份「走了某条路、且采到了样本」的实测结果（RTT 20/40/60）。
    ///
    /// ❗ 它**总是**带样本。要造「压根没测到」的场景请直接写 `LinkEnd`
    ///    字面量（全 0）—— 拿本函数去造会得到自相矛盾的输入。
    fn end(path: PathKind) -> LinkEnd {
        LinkEnd {
            path,
            rtt_min: 20,
            rtt_avg: 40,
            rtt_max: 60,
        }
    }

    fn facts<'a>(
        peer: &'a str,
        name: &'a str,
        phase: SessionPhase,
        started: i64,
        reason: &'a str,
    ) -> HistoryFacts<'a> {
        HistoryFacts {
            peer,
            peer_name: name,
            cap: Capability::View,
            phase,
            started_ms: started,
            reason,
            end: end(PathKind::Lan),
        }
    }

    #[test]
    fn append_then_list_roundtrips_and_caps_at_max() {
        let store = temp_store();
        for i in 0..(MAX as i64 + 5) {
            append_history(
                &store,
                facts(
                    &format!("peer{i}"),
                    &format!("name{i}"),
                    SessionPhase::OutboundActive,
                    i,
                    "test",
                ),
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
            facts("p", "n", SessionPhase::InboundActive, 100, "kicked"),
        );
        let list = list_history(&store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["dir"], "inbound");
        // duration = 落库时的 ended_ms - started_ms，不依赖再次读钟（避免 ±1ms 抖动）。
        let ended = list[0]["ended_ms"].as_i64().unwrap();
        assert_eq!(list[0]["duration_ms"], ended - 100);
        assert!(list[0]["duration_ms"].as_i64().unwrap() >= 0);
    }

    #[test]
    fn records_path_and_rtt_summary() {
        let store = temp_store();
        append_history(
            &store,
            facts("p", "n", SessionPhase::OutboundActive, 10, "done"),
        );
        let list = list_history(&store);
        assert_eq!(list[0]["path_kind"], "lan");
        assert_eq!(list[0]["rtt_min"], 20);
        assert_eq!(list[0]["rtt_avg"], 40);
        assert_eq!(list[0]["rtt_max"], 60);
    }

    #[test]
    fn no_path_records_empty_not_default() {
        let store = temp_store();
        let mut f = facts("p", "n", SessionPhase::OutboundActive, 10, "done");
        // 真正「一条路都没通、也没采到样本」的收尾结果。
        // ❗ 不能用 `end(PathKind::None)` —— 那个 helper 会连样本一起填上，
        //    造出来的不是「没测到」而是「测到了但路是 None」。
        f.end = LinkEnd {
            path: PathKind::None,
            rtt_min: 0,
            rtt_avg: 0,
            rtt_max: 0,
        };
        append_history(&store, f);
        let list = list_history(&store);
        // 前端据此**不显示**这一格——而不是显示成「绕中继」之类的默认值。
        assert_eq!(list[0]["path_kind"], "");
        assert_eq!(list[0]["rtt_avg"], 0);
    }
}
