//! 会话状态机与门禁（R0 核心）。
//!
//! # 红线
//!
//! 1. **无 Grant 会话即拒绝一切 Input 帧**——R0 只有信令，Input 在 R2，门禁先立。
//! 2. **被控端默认关**：`rc_enabled=false` 时入站 Request 直接 Deny。
//! 3. **设备级禁止**优先于能力档。
//! 4. **申请能力不得超过被控端能力上限**。

use super::protocol::{Capability, SessionPhase};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

/// 配置键。
pub const CFG_ENABLED: &str = "rc_enabled";
pub const CFG_CAPABILITY: &str = "rc_capability";
/// 设备级禁止：`{ "<node_id>": true }` 表示禁止该设备远程本机。
pub const CFG_DEVICE_DENY: &str = "rc_device_deny";

/// 一条会话记录（双向共用一份结构）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub id: String,
    /// 对端 node_id。
    pub peer: String,
    /// 对端设备名（展示用；门禁不看它）。
    pub peer_name: String,
    /// 已授权的能力（Active 后才有意义；Pending 时是申请值）。
    pub capability: Capability,
    pub phase: SessionPhase,
    pub started_ms: i64,
    /// 被控侧：是否本机用户已点头。
    pub granted: bool,
}

/// 门禁判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Allow,
    /// 本机「允许被远程」关着。
    Disabled,
    /// 该设备被单独禁止。
    DeviceDenied,
    /// 未配对。
    NotPaired,
    /// 申请能力超过本机能力上限。
    CapabilityTooHigh,
    /// 已有会话。
    Busy,
}

impl Gate {
    pub fn deny_reason(&self) -> &'static str {
        match self {
            Gate::Allow => "",
            Gate::Disabled => "对方未开启「允许被远程协助」",
            Gate::DeviceDenied => "对方已单独禁止这台设备远程",
            Gate::NotPaired => "设备未配对",
            Gate::CapabilityTooHigh => "申请的能力超过对方允许的上限",
            Gate::Busy => "对方已有进行中的远程会话",
        }
    }

    /// 稳定错误码：前端分档文案用，不要改字符串。
    pub fn deny_code(&self) -> &'static str {
        match self {
            Gate::Allow => "",
            Gate::Disabled => "disabled",
            Gate::DeviceDenied => "device_denied",
            Gate::NotPaired => "not_paired",
            Gate::CapabilityTooHigh => "capability_too_high",
            Gate::Busy => "busy",
        }
    }
}

/// 被控侧入站申请的门禁。
///
/// `paired` 由调用方查 `devices` 表给出（本模块不依赖 DataStore）。
pub fn gate_inbound(
    rc_enabled: bool,
    max_cap: Capability,
    device_deny: &HashMap<String, bool>,
    peer: &str,
    paired: bool,
    requested: Capability,
    has_session: bool,
) -> Gate {
    if !rc_enabled {
        return Gate::Disabled;
    }
    if !paired {
        return Gate::NotPaired;
    }
    if device_deny.get(peer).copied().unwrap_or(false) {
        return Gate::DeviceDenied;
    }
    if !requested.allowed_by(max_cap) {
        return Gate::CapabilityTooHigh;
    }
    if has_session {
        return Gate::Busy;
    }
    Gate::Allow
}

/// 发起侧本地预检（对端真正门禁仍在对端）。
pub fn gate_outbound(has_session: bool) -> Gate {
    if has_session {
        Gate::Busy
    } else {
        Gate::Allow
    }
}

/// 合法迁移表。返回 `false` = 拒绝迁移（调用方报错，状态不动）。
pub fn can_transition(from: SessionPhase, to: SessionPhase) -> bool {
    use SessionPhase::*;
    matches!(
        (from, to),
        (Idle, OutboundPending)
            | (Idle, InboundActive)
            | (OutboundPending, OutboundActive)
            | (OutboundPending, Idle)
            | (OutboundActive, Idle)
            | (InboundActive, Idle)
    )
}

/// 会话是否已建立（可谈画面/输入）。
pub fn is_active(phase: SessionPhase) -> bool {
    matches!(phase, SessionPhase::OutboundActive | SessionPhase::InboundActive)
}

/// 被控横幅是否必须展示。Active 时恒 true——不可关到看不见（规则 15）。
pub fn must_show_control_banner(phase: SessionPhase) -> bool {
    phase == SessionPhase::InboundActive
}

/// 生成会话 id。不用 uuid 依赖：时间 + 随机 4 字节够用（进程内唯一即可）。
pub fn new_session_id(now_ms: i64) -> String {
    let r = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        nanos
    };
    format!("rc-{}-{:08x}", now_ms, r)
}

#[cfg(test)]
mod tests {
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
}
