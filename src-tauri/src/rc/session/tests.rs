//! `session.rs` 状态机与门禁的单元测试（原样平移）。

use super::*;

fn deny_map(ids: &[&str]) -> HashMap<String, bool> {
    ids.iter().map(|s| (s.to_string(), true)).collect()
}

#[test]
fn ttl_expired锚定单调钟_缺锚保守不过期() {
    // 🔴 C3 守卫：判据只吃单调口径；started_mono=0（漏填/残值）永不判过期，
    // 边界严格 `>`（正好 2 小时不算，与 link_stale_kick / should_pause 同口径）。
    assert!(!ttl_expired(0, SESSION_TTL_MS * 10), "缺锚必须保守：不许秒杀活会话");
    // 锚在 1ms：「现在」= 1 + TTL ⇒ 恰好卡在阈值上，严格 `>` 不算过期
    assert!(!ttl_expired(1, SESSION_TTL_MS + 1), "正好卡在 TTL 上不算过期");
    assert!(ttl_expired(1, SESSION_TTL_MS + 2), "超出 1ms 就该过期");
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

/// 🔴 P1-6（2026-09-23 审计）：会话 id 的**唯一性**是收口凭据的地基。
///
/// `force_end_if_session` / `session_id_is` 全靠 id 认领会话；同一毫秒内
/// 建两场会话（断流后立刻重连就长这样）一旦撞上，旧任务的收口会命中新会话。
/// 判据钉在这里：id 必须互不相同，且不依赖机器时钟的分辨率。
#[test]
fn session_id_unique_within_same_millisecond() {
    let mut set = std::collections::HashSet::new();
    // 同一毫秒 2000 次（真实场景是「一次断线重连」量级，这里往死里压）
    for _ in 0..2000 {
        assert!(
            set.insert(new_session_id(1_757_000_000_000)),
            "同一毫秒内生成了重复的会话 id —— force_end 会误杀新会话"
        );
    }
    // 格式：三段（毫秒 / 纳秒尾 / 序号），前端只当不透明串比较，不解析
    let id = new_session_id(1_757_000_000_000);
    assert!(id.starts_with("rc-1757000000000-"), "前缀变了前端会看不懂：{id}");
    assert_eq!(id.split('-').count(), 4, "{id}");
}

#[test]
fn session_id_differs_across_milliseconds_too() {
    // 跨毫秒也不许相等（序号是进程内单调的，不随时间重置）
    assert_ne!(new_session_id(100), new_session_id(100));
    assert_ne!(new_session_id(100), new_session_id(101));
}
