//! `session.rs` 状态机与门禁的单元测试（原样平移）。

use super::*;

fn deny_map(ids: &[&str]) -> HashMap<String, bool> {
    ids.iter().map(|s| (s.to_string(), true)).collect()
}

#[test]
fn inbound_disabled_by_default() {
    let g = gate_inbound(
        false,
        Capability::Control,
        &HashMap::new(),
        "peer",
        true,
        Capability::View,
        false,
    );
    assert_eq!(g, Gate::Disabled);
}

#[test]
fn inbound_requires_pairing() {
    let g = gate_inbound(
        true,
        Capability::View,
        &HashMap::new(),
        "peer",
        false,
        Capability::View,
        false,
    );
    assert_eq!(g, Gate::NotPaired);
}

#[test]
fn inbound_device_deny() {
    let g = gate_inbound(
        true,
        Capability::Control,
        &deny_map(&["peer"]),
        "peer",
        true,
        Capability::View,
        false,
    );
    assert_eq!(g, Gate::DeviceDenied);
}

#[test]
fn inbound_capability_cap() {
    let g = gate_inbound(
        true,
        Capability::View,
        &HashMap::new(),
        "peer",
        true,
        Capability::Control,
        false,
    );
    assert_eq!(g, Gate::CapabilityTooHigh);
}

#[test]
fn inbound_busy() {
    let g = gate_inbound(
        true,
        Capability::Control,
        &HashMap::new(),
        "peer",
        true,
        Capability::View,
        true,
    );
    assert_eq!(g, Gate::Busy);
}

#[test]
fn inbound_allow() {
    let g = gate_inbound(
        true,
        Capability::Control,
        &HashMap::new(),
        "peer",
        true,
        Capability::View,
        false,
    );
    assert_eq!(g, Gate::Allow);
}

#[test]
fn transitions() {
    use SessionPhase::*;
    assert!(can_transition(Idle, OutboundPending));
    assert!(can_transition(OutboundPending, OutboundActive));
    assert!(can_transition(OutboundActive, Idle));
    // 非法
    assert!(!can_transition(Idle, OutboundActive));
    assert!(!can_transition(OutboundPending, InboundActive));
    assert!(!can_transition(OutboundActive, OutboundPending));
}

#[test]
fn banner_required_when_inbound_active() {
    assert!(must_show_control_banner(SessionPhase::InboundActive));
    assert!(!must_show_control_banner(SessionPhase::OutboundActive));
}

#[test]
fn can_transition_busy_rules() {
    use SessionPhase::*;
    // approve_inbound 从无会话直达 InboundActive 是本就存在的迁移
    assert!(can_transition(Idle, InboundActive));
    // 进行中的发起会话不能被新入站申请顶掉（[busy_local] 闸）
    assert!(!can_transition(OutboundActive, InboundActive));
    // 已经在进行中的被控会话不能被再次 approve 顶掉
    assert!(!can_transition(InboundActive, InboundActive));
}
