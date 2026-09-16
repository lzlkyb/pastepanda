//! 远程电脑帧协议（R0）。
//!
//! 独立 ALPN，不与 `pastepanda-sync/1` 混流。控制帧用 JSON，
//! 因为 Request/Accept/Deny/End 都是小而稀的信令；画面帧（R1 下一期）
//! 才会走二进制 + 长度前缀。

use serde::{Deserialize, Serialize};

/// 远程协助 ALPN。带版本：协议不兼容时连不上，好过连上后乱解析。
pub const ALPN: &[u8] = b"pastepanda/rc/1";

/// 能力档。`Control` 包含 `View`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// 只看画面。
    View,
    /// 可控（含只看）。
    Control,
}

impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::View => "view",
            Capability::Control => "control",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "view" => Some(Capability::View),
            "control" => Some(Capability::Control),
            _ => None,
        }
    }

    /// 申请的能力是否被本机能力上限覆盖。
    pub fn allowed_by(self, max: Capability) -> bool {
        matches!(
            (self, max),
            (Capability::View, Capability::View)
                | (Capability::View, Capability::Control)
                | (Capability::Control, Capability::Control)
        )
    }
}

/// 控制帧。会话建立前只有信令；画面/输入帧另开类型（R1/R2）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum RcFrame {
    /// 发起端申请会话。
    Request { capability: Capability },
    /// 被控端同意。
    Accept { capability: Capability },
    /// 被控端拒绝 / 门禁未过。`code` 供前端分档文案，旧对端可能没有。
    Deny {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// 任一方结束会话。
    End { reason: String },
    /// 心跳占位（R1 画面流前先保活）。
    Ping,
    Pong,
}

impl RcFrame {
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(self).map_err(|e| format!("编码 RC 帧失败：{}", e))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|e| format!("解码 RC 帧失败：{}", e))
    }
}

/// 会话阶段。状态机只允许合法迁移；非法迁移一律 Err。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPhase {
    /// 无会话。
    Idle,
    /// 本机已发出申请，等对端点头。
    OutboundPending,
    /// 本机在控制对端。
    OutboundActive,
    /// 本机正在被控制。
    InboundActive,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_subset() {
        assert!(Capability::View.allowed_by(Capability::View));
        assert!(Capability::View.allowed_by(Capability::Control));
        assert!(Capability::Control.allowed_by(Capability::Control));
        assert!(!Capability::Control.allowed_by(Capability::View));
    }

    #[test]
    fn frame_roundtrip() {
        let f = RcFrame::Request {
            capability: Capability::Control,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
    }

    #[test]
    fn deny_with_code_roundtrip() {
        let f = RcFrame::Deny {
            reason: "对方未开启".into(),
            code: Some("disabled".into()),
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 旧格式无 code 仍可解
        let old = r#"{"t":"deny","reason":"busy"}"#.as_bytes();
        match RcFrame::decode(old).unwrap() {
            RcFrame::Deny { reason, code } => {
                assert_eq!(reason, "busy");
                assert_eq!(code, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn capability_parse() {
        assert_eq!(Capability::parse("view"), Some(Capability::View));
        assert_eq!(Capability::parse("control"), Some(Capability::Control));
        assert_eq!(Capability::parse("nope"), None);
    }
}
