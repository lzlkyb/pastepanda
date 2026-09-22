//! 远程电脑帧协议（R0）。
//!
//! 独立 ALPN，不与 `pastepanda-sync/1` 混流。控制帧用 JSON，
//! 因为 Request/Accept/Deny/End 都是小而稀的信令；画面帧（R1 下一期）
//! 才会走二进制 + 长度前缀。

use serde::{Deserialize, Serialize};

/// 远程协助 ALPN。带版本：协议不兼容时连不上，好过连上后乱解析。
pub const ALPN: &[u8] = b"pastepanda/rc/1";

/// G6 文件传输 ALPN。**挂同一个 RC 端点**（`rc/net.rs` 双 ALPN），
/// 不新绑端口、不新开 relay 连接。
///
/// 为什么不复用 `rc/1` 会话连接开条 uni 流：会话有 TTL + 2s 心跳、断流即
/// 收口（`outbound.rs` 的 force_end），传大文件必废；且旧版对端不会
/// `accept_uni`，数据会堵在流控窗口里**静默卡死**（没有错误，只有「点了没反应」）。
/// 独立 ALPN 的失败是**明确拒绝**——版本不匹配时对端根本连不上这条流，
/// 于是前端能说清「对方版本不支持文件传输」，而不是塌缩成「连接失败」。
pub const FILE_ALPN: &[u8] = b"pastepanda/rc-file/1";

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
        /// G3：发起端申请系统声音（音频流）。`None`/false = 旧版发起端或用户
        /// 关了声音——被控端不开音频采集。与 `vid_dgram` 同款兼容三件套。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<bool>,
    },
    /// 被控端同意。
    Accept {
        capability: Capability,
        /// 被控端**自报的操作系统**短标签（如 `Windows 11`）。
        ///
        /// 兼容三件套与 `vid_dgram` 同款：旧被控端不认这个字段，serde 忽略未知键
        /// 照常受理（新版连旧版 = 设备行上少一格系统，不影响会话）；旧被控端
        /// **发**来的 Accept 没有它，`default` 补 None。控制端收到后写进设备行
        /// （`rc_devices.os`），设备详情显示。
        ///
        /// ❗ 为什么挂在 `Accept` 而不是配对手势包（`sync::presence::Extras` /
        ///   邀请码）：所有会话——敲门 / 邀请码 / 无人值守码 / 固定密码 / 免确认
        ///   自动接受——**都必经这一处** Accept（`service.rs` 里 `Accept` 只有一处
        ///   构造）。单承载点没有「某条配对路径漏传」的缺口；而 `Extras` 是 rc 与
        ///   笔记同步**共用**结构，改它要连带回归同步域。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        os: Option<String>,
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
            audio: None,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 可选能力为 None 时不序列化对应字段（线上包保持最小）
        let minimal = RcFrame::Request {
            capability: Capability::View,
            uno_code: None,
            uno_pass: None,
            vid_dgram: None,
            audio: None,
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
            audio: None,
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
            audio: None,
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
            audio: None,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 旧版对端发来的 Request 没有 uno_code/uno_pass 字段，也要能解（default 补 None）
        let old = r#"{"t":"request","capability":"control"}"#.as_bytes();
        match RcFrame::decode(old).unwrap() {
            RcFrame::Request { capability, uno_code, uno_pass, vid_dgram, audio } => {
                assert_eq!(capability, Capability::Control);
                assert_eq!(uno_code, None, "旧对端没有这个字段，反序列化补 None");
                assert_eq!(uno_pass, None, "固定密码位同理（方案 C）");
                assert_eq!(vid_dgram, None, "能力位同理");
                assert_eq!(audio, None, "音频申请位同理（G3）");
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
    fn accept_carries_os_and_stays_compatible() {
        // 带系统：原样往返
        let f = RcFrame::Accept {
            capability: Capability::Control,
            os: Some("Windows 11".into()),
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        assert!(
            String::from_utf8(b).unwrap().contains("Windows 11"),
            "自报的系统要真的在线上包里"
        );

        // 不带系统（旧本机 / 注册表采不到）：不序列化该字段，线上包保持最小
        let minimal = RcFrame::Accept {
            capability: Capability::View,
            os: None,
        };
        let s = String::from_utf8(minimal.encode().unwrap()).unwrap();
        assert!(
            !s.contains("\"os\""),
            "没有系统时不该把 os 发出去（发 null 是多余的线上字节）：{s}"
        );

        // 旧被控端发来的 Accept 没有 os 字段，也要能解（default 补 None）
        let old = br#"{"t":"accept","capability":"view"}"#;
        match RcFrame::decode(old).unwrap() {
            RcFrame::Accept { capability, os } => {
                assert_eq!(capability, Capability::View);
                assert_eq!(os, None, "旧被控端没有这个字段，反序列化补 None");
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
