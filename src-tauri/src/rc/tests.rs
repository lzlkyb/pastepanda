//! R0 门禁与状态机单测（不起网络、不起 tauri）。

use crate::data_store::DataStore;
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::RcService;
use crate::rc::session::{gate_inbound, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};

fn store() -> DataStore {
    DataStore::new(":memory:").expect("open store")
}

fn set_cfg(store: &DataStore, key: &str, val: serde_json::Value) {
    let mut c = store.get_config().unwrap_or_default();
    c.as_object_mut().unwrap().insert(key.to_string(), val);
    store.save_config(&c).unwrap();
}

#[test]
fn default_rejects_everything() {
    let s = store();
    let svc = RcService::new(s.clone());
    assert!(!svc.enabled());
    assert_eq!(svc.max_capability(), Capability::View);
    // 无会话时 require_active 必须失败
    assert!(svc.require_active().is_err());
    assert!(!svc.must_show_banner());
}

#[test]
fn settings_roundtrip() {
    let s = store();
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("control"));
    let mut deny = serde_json::Map::new();
    deny.insert("peer-a".into(), serde_json::Value::Bool(true));
    set_cfg(&s, CFG_DEVICE_DENY, serde_json::Value::Object(deny));

    let svc = RcService::new(s);
    assert!(svc.enabled());
    assert_eq!(svc.max_capability(), Capability::Control);
    assert!(svc.device_deny().get("peer-a").copied().unwrap_or(false));
}

#[tokio::test]
async fn request_without_rc_pair_fails() {
    let s = store();
    // 只做**同步**配对，不做远程配对——远程必须走 rc_devices
    s.device_pair(&"aa".repeat(32), "同步机", "").unwrap();
    let svc = RcService::new(s);
    let err = svc
        .request_session(&"aa".repeat(32), Capability::View)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对") || err.contains("通道"), "{err}");
}

#[tokio::test]
async fn request_rc_paired_but_no_transport() {
    let s = store();
    s.rc_device_pair(&"bb".repeat(32), "远程机").unwrap();
    let svc = RcService::new(s);
    // 有配对 → needs_channel 为真，但通道尚未 start
    assert!(svc.needs_channel());
    assert!(!svc.enabled(), "发起不依赖「允许被远程」");
    let err = svc
        .request_session(&"bb".repeat(32), Capability::View)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "{err}");
    assert!(svc.require_active().is_err());
}

#[test]
fn needs_channel_when_paired_without_being_remoted() {
    let s = store();
    assert!(!RcService::new(s.clone()).needs_channel());
    s.rc_device_pair(&"cc".repeat(32), "甲").unwrap();
    let svc = RcService::new(s.clone());
    assert!(svc.needs_channel(), "有远程配对就该起通道（发起）");
    assert!(!svc.enabled());
    // 打开被控后同样需要通道
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    let svc2 = RcService::new(s);
    assert!(svc2.needs_channel());
}

#[test]
fn needs_channel_when_only_sync_paired() {
    // B9：仅同步配对、无远程配对、未开被控 → 仍要起通道，
    // 否则用户看得见设备（source="sync"）却发不起。
    let s = store();
    s.device_pair(&"ff".repeat(32), "同步机", "").unwrap();
    let svc = RcService::new(s);
    assert!(!svc.enabled(), "发起不依赖「允许被远程」");
    assert!(
        svc.needs_channel(),
        "仅同步配对也要起通道（发起），否则列得出却发不起"
    );
}

#[test]
fn sync_pair_grants_remote_trust() {
    // 方案 A：同步配对 → 可直接远程；远程配对 → 不自动进同步
    let s = store();
    let peer = "dd".repeat(32);
    s.device_pair(&peer, "同步机", "").unwrap();
    let svc = RcService::new(s.clone());
    assert!(svc.has_remote_trust(&peer), "同步配对应有远程信任");
    assert!(matches!(s.rc_device_get(&peer), Ok(None)), "尚未 elevate");
    // elevate 幂等写入 rc_devices
    svc.elevate_from_sync(&peer).unwrap();
    assert!(matches!(s.rc_device_get(&peer), Ok(Some(_))));
    // 反向：仅有 rc_devices 不应出现在同步 devices
    let only_rc = "ee".repeat(32);
    s.rc_device_pair(&only_rc, "远程机").unwrap();
    assert!(matches!(s.device_get(&only_rc), Ok(None)));
    assert!(RcService::new(s).has_remote_trust(&only_rc));
}

#[test]
fn approve_without_pending_fails() {
    let s = store();
    let svc = RcService::new(s);
    assert!(svc.approve_inbound("peer").is_err());
    assert!(svc.deny_inbound("peer").is_err());
}

#[tokio::test]
async fn end_without_session_fails() {
    let s = store();
    let svc = RcService::new(s);
    assert!(svc.end_session("x").await.is_err());
}

#[test]
fn inbound_gate_matrix_in_service_config() {
    // 服务未开 → Disabled
    let s = store();
    let svc = RcService::new(s.clone());
    let g = gate_inbound(
        svc.enabled(),
        svc.max_capability(),
        &svc.device_deny(),
        "p",
        true,
        Capability::View,
        false,
    );
    assert_eq!(g, crate::rc::session::Gate::Disabled);

    // 开了但能力不够
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("view"));
    let svc = RcService::new(s);
    let g = gate_inbound(
        svc.enabled(),
        svc.max_capability(),
        &svc.device_deny(),
        "p",
        true,
        Capability::Control,
        false,
    );
    assert_eq!(g, crate::rc::session::Gate::CapabilityTooHigh);
}

#[test]
fn phase_idle_by_default() {
    let s = store();
    let svc = RcService::new(s);
    let st = svc.status();
    assert!(st.session.is_none());
    assert!(st.pending.is_empty());
    assert_eq!(st.session.map(|x| x.phase), None);
    let _ = SessionPhase::Idle;
}

// —— C8(b)：剪贴板 pull 的等待判定 ——
//
// 要防的是「跨会话串剪贴板」：上一个会话超时后**迟到**的回包会把 clip_seq
// 顶上去，如果只看 seq，本次 pull 就会误以为数据到了，把别的会话的剪贴板
// 内容当作本次结果返回。所以判定必须同时认「会话代」。

mod clip_wait {
    use crate::rc::clipboard::{clip_wait_decision, ClipWait};

    #[test]
    fn takes_when_seq_advanced() {
        assert_eq!(clip_wait_decision(0, 0, 5, 4), ClipWait::Take);
    }

    #[test]
    fn keeps_waiting_when_seq_unchanged() {
        assert_eq!(clip_wait_decision(0, 0, 4, 4), ClipWait::KeepWaiting);
    }

    #[test]
    fn abandons_on_session_switch_even_if_seq_advanced() {
        // 核心用例：seq 涨了（5 > 4）但会话已换 → 绝不能 Take
        assert_eq!(clip_wait_decision(1, 0, 5, 4), ClipWait::Abandon);
    }

    #[test]
    fn abandons_on_session_switch_even_without_reply() {
        assert_eq!(clip_wait_decision(7, 6, 2, 2), ClipWait::Abandon);
    }

    #[test]
    fn abandon_wins_over_take() {
        // 会话已切换时，不管 seq 怎么变，都必须是 Abandon
        for seq_now in [0u64, 1, 4, 5, 100] {
            assert_eq!(
                clip_wait_decision(2, 1, seq_now, 4),
                ClipWait::Abandon,
                "seq_now={seq_now} 时被 seq 抢判了"
            );
        }
    }

    #[test]
    fn take_requires_strictly_greater_seq() {
        // seq 相等说明回包还没来；写成 >= 会在「上一次 pull 的回包」上误判
        assert_eq!(clip_wait_decision(3, 3, 9, 9), ClipWait::KeepWaiting);
    }
}

// —— B3：被控端要能收到「对端改了画面范围」 ——

mod scope_notice {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn notify_callback_receives_scope() {
        let svc = RcService::new(store());
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = got.clone();
        svc.set_scope_notify(Arc::new(move |scope: &str| {
            sink.lock().unwrap().push(scope.to_string());
        }));

        svc.emit_scope_changed("primary");
        svc.emit_scope_changed("monitor:1");

        // 原样透传，不能被吞掉或改写——前端靠它拼「改成了 X」的提示
        assert_eq!(
            *got.lock().unwrap(),
            vec!["primary".to_string(), "monitor:1".to_string()]
        );
    }

    #[test]
    fn no_callback_is_not_a_panic() {
        // 没注册回调（例如单测/无 GUI 环境）时调用不能崩
        let svc = RcService::new(store());
        svc.emit_scope_changed("virtual");
    }

    #[test]
    fn local_scope_change_does_not_notify() {
        // 本机自己在设置页改范围（set_stream_scope）不该触发「对端改了」提示，
        // 否则被控端会被自己点的操作弹一条误导性通知。
        let svc = RcService::new(store());
        let hits = Arc::new(Mutex::new(0usize));
        let sink = hits.clone();
        svc.set_scope_notify(Arc::new(move |_s: &str| {
            *sink.lock().unwrap() += 1;
        }));

        svc.set_stream_scope("primary").expect("合法 scope");
        svc.set_stream_scope("monitor:0").expect("合法 scope");

        assert_eq!(*hits.lock().unwrap(), 0, "本机改范围不应通知被控提示");
    }
}
