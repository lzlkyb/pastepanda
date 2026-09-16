//! 会话状态机与门禁（R0 核心）。
//!
//! # 红线
//!
//! 1. **无 Grant 会话即拒绝一切 Input 帧**——R0 只有信令，Input 在 R2，门禁先立。
//! 2. **被控端默认关**：`rc_enabled=false` 时入站 Request 直接 Deny。
//! 3. **设备级禁止**优先于能力档。
//! 4. **申请能力不得超过被控端能力上限**。

use super::protocol::{Capability, RcFrame, SessionPhase};
use super::service::RcService;
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

/// 活跃会话最长持续（毫秒）。超时后推流循环自动结束，避免无人值守挂死。
pub(super) const SESSION_TTL_MS: i64 = 2 * 60 * 60 * 1000;

/// 会话生命周期（Tier B 第 5 组：从 `service.rs` 归位到状态机文件）。
///
/// 为什么放这里：上面是「状态**能不能**变」（转移表 + 门禁），这一块是「状态
/// **怎么变**」（建立后的收口/判定）。拆在两个文件里，改转移表的人看不到收口
/// 顺序，改收口的人看不到转移表——A2（重连自杀）那种 bug 正是出在这个缝里。
///
/// 这些方法要碰的 `RcService` 字段标了 `pub(super)`（见那边的可见性说明）；
/// 四个子结构体（clip / notify / stream / pressed 的内部字段）仍然私有。
impl RcService {
    pub async fn end_session(&self, reason: &str) -> Result<(), String> {
        let (peer, peer_name, cap, phase, started) = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(s) = inner.session.as_ref() else {
                return Err("没有进行中的会话".into());
            };
            log::info!("[RC] 会话结束：{reason}");
            (s.peer.clone(), s.peer_name.clone(), s.capability, s.phase, s.started_ms)
        };
        // 尽力通知对端：发起端走 outbound_send；被控端走 inbound_send
        {
            let mut guard = self.outbound_send.lock().await;
            if let Some(send) = guard.as_mut() {
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(send, &b).await;
                }
            }
            *guard = None;
        }
        {
            let ib = self.inbound_send.lock().await.take();
            if let Some(send) = ib {
                let mut g = send.lock().await;
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(&mut g, &b).await;
                }
            }
        }
        // 补发卡住的 up：对端断线/会话结束时，被按住的 Ctrl/Shift/鼠标键不会自动弹起。
        // ⚠️ 必须在清 session 之前、且直接调注入函数（release_all），不要走 handle_inbound_input——
        // 会话结束态下它的 session_capability() 返回 None，能力校验会拦掉释放。
        // `end_session_releases_pressed_keys` 单测钉住「释放确实发生了」。
        {
            let mut g = self.pressed.lock().unwrap_or_else(|p| p.into_inner());
            g.release_all();
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.session = None;
            inner.pending.clear();
        }
        let _ = self.store.rc_device_touch(&peer, false);
        super::history::append_history(&self.store, &peer, &peer_name, cap, phase, started, reason);
        self.clear_frame();
        self.note_rtt(0);
        // C8(b)：作废仍在等待的剪贴板 pull，并清掉可能由迟到回包写入的文本，
        // 避免下一个会话把它当成自己的结果返回。
        self.invalidate_clipboard();
        // 收口时清空注入错误（已被前端看到或已无意义）
        self.notify.take_inject_err();
        *self
            .last_outbound_error
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.emit_changed();
        Ok(())
    }

    /// 当前会话 id 是否等于给定值（收口按 session id 判定，避免重连时被旧任务按 peer 误杀）。
    pub fn session_id_is(&self, id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.id == id)
    }

    /// 流断开 / 对端消失时本地收口：只清**该 session id** 的会话，避免误杀同 peer 的新会话。
    pub async fn force_end_if_session(&self, session_id: &str, reason: &str) {
        let should = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            matches!(inner.session.as_ref(), Some(s) if s.id == session_id)
        };
        if !should {
            return;
        }
        log::info!("[RC] 强制结束会话（{session_id}）：{reason}");
        let _ = self.end_session(reason).await;
    }

    /// 会话是否超过 TTL（推流循环每圈检查）。
    pub fn session_expired(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => super::service::now_ms() - s.started_ms > SESSION_TTL_MS,
            _ => false,
        }
    }

    pub fn require_active(&self) -> Result<Session, String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => Ok(s.clone()),
            Some(_) => Err("会话尚未建立".into()),
            None => Err("没有进行中的远程会话".into()),
        }
    }

    pub fn must_show_banner(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(
            inner.session.as_ref(),
            Some(s) if s.phase == SessionPhase::InboundActive
        )
    }
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
