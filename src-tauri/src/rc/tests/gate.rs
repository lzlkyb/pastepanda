//! 配对门 / 能力门 / needs_channel / 入站门禁矩阵。

use super::{set_cfg, store};
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::RcService;
use crate::rc::session::{gate_inbound, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};

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
        .request_session(&"aa".repeat(32), Capability::View, None, None)
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
        .request_session(&"bb".repeat(32), Capability::View, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "{err}");
    assert!(svc.require_active().is_err());
}

#[tokio::test]
async fn request_with_uno_code_skips_pairing_gate() {
    // Q2 方案 B：带无人值守接入码的发起，目标机器**本来就未配对**——
    // 老的配对门必须让位，卡点后移到「通道未启动」（对端验码发生在拨通之后）。
    let s = store();
    let svc = RcService::new(s.clone());
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, Some("AB2C-3DEF".into()), None)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "带码不该死在配对门：{err}");
    // 对照组：同一台机器，不带码 → 老门照旧拦下
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对"), "{err}");
    // 空串视同没带码，不绕门
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, Some("  ".into()), None)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对"), "{err}");
}

#[test]
fn needs_channel_when_paired_without_being_remoted() {    let s = store();
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
