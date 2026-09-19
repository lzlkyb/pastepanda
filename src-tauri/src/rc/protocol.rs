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
    Request {
        capability: Capability,
        /// 无人值守接入码（Q2 方案 B）。`None` = 常规申请（配对设备 / 敲门）。
        ///
        /// ❗ 兼容性三件套一个不能少：旧对端**收**到带码的 Request 时 serde 默认
        /// 忽略未知字段，照常按敲门处理（新版连旧版 = 退化为「要人点头」）；
        /// 旧对端**发**来的 Request 没有这个字段，`default` 补 None。
        /// 字段名别改——它是线上的 JSON 键。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uno_code: Option<String>,
        /// 固定接入密码（Q2 方案 C，`rc/unop.rs`）。`None` = 没带。
        ///
        /// 与 `uno_code` 互斥携带（同时带时被控端只认码）；兼容三件套同理——
        /// 旧版被控端不认识这个字段，按敲门处理（退化为「要人点头」）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uno_pass: Option<String>,
        /// 发起端视频能力位：true = 支持视频数据报（分片 + FEC）。`None`/false =
        /// 旧版发起端——它没有视频数据报读取任务，P 帧走数据报会静默丢失
        ///（画面退化成每秒一张关键帧的幻灯片），所以被控端按可靠流发 P 帧。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vid_dgram: Option<bool>,
    },
    /// 被控端同意。
    Accept {
        capability: Capability,
    },
    /// 被控端拒绝 / 门禁未过。`code` 供前端分档文案，旧对端可能没有。
    Deny {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// 任一方结束会话。
    End {
        reason: String,
    },
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
            uno_code: None,
            uno_pass: None,
            vid_dgram: Some(true),
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 可选能力为 None 时不序列化对应字段（线上包保持最小）
        let minimal = RcFrame::Request {
            capability: Capability::View,
            uno_code: None,
            uno_pass: None,
            vid_dgram: None,
        };
        let s = String::from_utf8(minimal.encode().unwrap()).unwrap();
        assert!(!s.contains("uno_code"));
        assert!(!s.contains("uno_pass"));
        assert!(!s.contains("vid_dgram"));
    }

    #[test]
    fn request_with_uno_pass_roundtrip() {
        let f = RcFrame::Request {
            capability: Capability::Control,
            uno_code: None,
            uno_pass: Some("s3cret-密码".into()),
            vid_dgram: None,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        let s = String::from_utf8(b).unwrap();
        assert!(s.contains("uno_pass"));
        // uno_code 与 uno_pass 不互相污染：带码不带密码的帧解回来不能多出密码
        let f2 = RcFrame::Request {
            capability: Capability::View,
            uno_code: Some("AB2C-3DEF".into()),
            uno_pass: None,
            vid_dgram: None,
        };
        let s2 = String::from_utf8(f2.encode().unwrap()).unwrap();
        assert!(!s2.contains("uno_pass"));
        assert_eq!(RcFrame::decode(s2.as_bytes()).unwrap(), f2);
    }

    #[test]
    fn request_with_uno_code_roundtrip() {
        let f = RcFrame::Request {
            capability: Capability::View,
            uno_code: Some("AB2C-3DEF".into()),
            uno_pass: None,
            vid_dgram: None,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 旧版对端发来的 Request 没有 uno_code/uno_pass 字段，也要能解（default 补 None）
        let old = r#"{"t":"request","capability":"control"}"#.as_bytes();
        match RcFrame::decode(old).unwrap() {
            RcFrame::Request { capability, uno_code, uno_pass, vid_dgram } => {
                assert_eq!(capability, Capability::Control);
                assert_eq!(uno_code, None, "旧对端没有这个字段，反序列化补 None");
                assert_eq!(uno_pass, None, "固定密码位同理（方案 C）");
                assert_eq!(vid_dgram, None, "能力位同理");
            }
            other => panic!("unexpected {other:?}"),
        }
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
