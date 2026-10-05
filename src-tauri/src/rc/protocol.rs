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
    /// 只查询双方是否都已粘贴对方的配对码；不创建远程会话。
    PairCheck {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        os: Option<String>,
    },
    PairStatus {
        paired: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        os: Option<String>,
    },
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
        /// P3.1：发起端能解 **RS FEC** 视频数据报（vid_dgram 置位才有意义）。
        /// `None`/false = 旧版发起端——被控端照走 XOR 老格式（RS 帧的
        /// frag_count 字段语义变了，旧重组器解不了）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fec_rs: Option<bool>,
        /// G3：发起端申请系统声音（音频流）。`None`/false = 旧版发起端或用户
        /// 关了声音——被控端不开音频采集。与 `vid_dgram` 同款兼容三件套。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<bool>,
        /// 发起端视频能力位：true = 支持在**独立单向流**上收视频（2026-10-03
        /// 「传输分 plane」方案）。`None`/false = 旧版发起端——被控端把视频
        /// 继续写在会话半流里（与 pong/输入共流，积压不可丢弃的历史形态）。
        /// 置位后被控端把 H.264 帧写到专属 uni 流（`PPVID1` 流头，见
        /// `video::wire`），积压熔断可持续超阈时**整流重建**（丢弃积压），
        /// 且视频写不再阻塞 pong/输入。兼容三件套：旧版被控端不认识这个
        /// 字段照常受理（视频留在半流，行为同今天）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        video_plane: Option<bool>,
        /// JPEG 及其元数据也支持独立媒体流；旧 video_plane 仅支持 H.264。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_plane: Option<bool>,
        /// 完整接收及实际上屏反馈；缺省为旧客户端，不等待它不存在的 ACK。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_feedback: Option<bool>,
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
    // 🔴 这里曾有 R1 时代的单元变体 `Ping` / `Pong`（注释写"心跳占位，画面流前先保活"），
    //    2026-09-23 删除。它们是**死代码**（全库零生产者），却因为 `#[serde(tag = "t")]`
    //    与真正的心跳 JSON `{"t":"pong","ts":…,"hts":…}` **tag 撞车**：serde 按 tag 命中
    //    单元变体后返回 `Ok(Pong)`，`outbound::handle_control` 的 `Ok(_) => {}` 空分支
    //    把它吃掉 —— RTT 处理整段永不执行，`link::last_pong_ms` 恒 0。
    //
    //    后果在 v7.2.5 才显形：该版新加的半开链路看门狗（`link::LINK_STALE_KICK_MS`）
    //    拿 `last_pong_ms` 当唯一活性证据 ⇒ **本机控制对端的会话 15 秒必被误踢**
    //    （用户现象：「连接已中断，重连几次一直断」）。
    //
    // ❗ 不要再把这两个变体加回来。心跳一律走 JSON 控制帧
    //    （`input::InputEvent::Ping` ↔ `{"t":"pong"}`），`RcFrame` 只承载信令
    //    （request / accept / deny / end）。删除后旧对端若发 `{"t":"ping"}`，
    //    只是从「被 Ok(_) 静默忽略」变成「进 JSON 分支后被兜底忽略」，线上等价。
    //    守卫见 tests::heartbeat_json_must_not_be_claimed_by_rc_frame。
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

    /// 🔴 守卫（2026-09-23，v7.2.5 回归的根因）：**心跳等 JSON 控制帧必须走不到 `RcFrame`**。
    ///
    /// 被控端回的心跳是 JSON `{"t":"pong","ts":…,"hts":…}`，全靠
    /// `outbound::handle_control` 里 `RcFrame::decode` **失败**（serde 报
    /// unknown variant）才被分派给后面的 JSON 分支。一旦有人在 `RcFrame` 里加回
    /// 一个 tag 为 `pong` 的变体，它就会被 `Ok(_) => {}` 静默吞掉 ⇒ `note_pong`
    /// 永不执行 ⇒ `link::last_pong_ms` 恒 0 ⇒ 半开看门狗把**活着的**会话判成
    /// 对端失联（15 秒必断）。
    ///
    /// 同族的 `vrect` / `vts` / `cursor` / `clip` / `caps` 一并钉住：它们的 tag
    /// 都不在 `RcFrame` 里，必须全部落到 JSON 分支 —— 少一个就说明撞车又回来了。
    #[test]
    fn heartbeat_json_must_not_be_claimed_by_rc_frame() {
        let cases: &[&[u8]] = &[
            br#"{"t":"pong","ts":1790166313975,"hts":1790166313980}"#.as_slice(),
            br#"{"t":"vrect","x":1,"y":2,"w":3,"h":4}"#.as_slice(),
            br#"{"t":"vts","ts":1,"cap":2,"enc":3}"#.as_slice(),
            br#"{"t":"cursor","s":"default"}"#.as_slice(),
            br#"{"t":"clip","text":"x"}"#.as_slice(),
            br#"{"t":"caps","fps120":true,"hz":144}"#.as_slice(),
        ];
        for raw in cases {
            assert!(
                RcFrame::decode(raw).is_err(),
                "{} 被 RcFrame 认领了——它会被 handle_control 的 `Ok(_) => {{}}` \
                 静默吞掉，链路活性判据随即失效（见本测试文档注释与 `RcFrame` 尾注）",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn pair_identity_is_compatible_with_older_frames() {
        assert_eq!(RcFrame::decode(br#"{"t":"pair_check"}"#).unwrap(),
            RcFrame::PairCheck { name: None, os: None });
        assert_eq!(RcFrame::decode(br#"{"t":"pair_status","paired":true}"#).unwrap(),
            RcFrame::PairStatus { paired: true, name: None, os: None });
        let frame = RcFrame::PairCheck { name: Some("Pixel 9".into()), os: Some("Android".into()) };
        assert_eq!(RcFrame::decode(&frame.encode().unwrap()).unwrap(), frame);
        // Older peers ignore new optional fields on both variants.
        #[derive(serde::Deserialize)]
        #[serde(tag = "t", rename_all = "snake_case")]
        enum Legacy { PairCheck, PairStatus { paired: bool } }
        assert!(matches!(serde_json::from_slice::<Legacy>(&frame.encode().unwrap()).unwrap(), Legacy::PairCheck));
        let response = RcFrame::PairStatus { paired: true, name: Some("PC".into()), os: Some("Windows 11".into()) };
        assert!(matches!(serde_json::from_slice::<Legacy>(&response.encode().unwrap()).unwrap(), Legacy::PairStatus { paired: true }));
    }

    #[test]
    fn frame_roundtrip() {
        assert_eq!(RcFrame::decode(&RcFrame::PairCheck { name: None, os: None }.encode().unwrap()).unwrap(), RcFrame::PairCheck { name: None, os: None });
        assert_eq!(
            RcFrame::decode(&RcFrame::PairStatus { paired: true, name: None, os: None }.encode().unwrap()).unwrap(),
            RcFrame::PairStatus { paired: true, name: None, os: None }
        );
        let f = RcFrame::Request {
            capability: Capability::Control,
            uno_code: None,
            uno_pass: None,
            vid_dgram: Some(true),
            fec_rs: Some(true),
            audio: None,
            video_plane: Some(true),
            media_plane: Some(true),
            media_feedback: Some(true),
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 可选能力为 None 时不序列化对应字段（线上包保持最小）
        let minimal = RcFrame::Request {
            capability: Capability::View,
            uno_code: None,
            uno_pass: None,
            vid_dgram: None,
            fec_rs: None,
            audio: None,
            video_plane: None,
            media_plane: None,
            media_feedback: None,
        };
        let s = String::from_utf8(minimal.encode().unwrap()).unwrap();
        assert!(!s.contains("uno_code"));
        assert!(!s.contains("uno_pass"));
        assert!(!s.contains("vid_dgram"));
        assert!(!s.contains("media_feedback"));
        assert!(!s.contains("video_plane"), "缺省位不占线上字节");
    }

    #[test]
    fn request_with_uno_pass_roundtrip() {
        let f = RcFrame::Request {
            capability: Capability::Control,
            uno_code: None,
            uno_pass: Some("s3cret-密码".into()),
            vid_dgram: None,
            fec_rs: None,
            audio: None,
            video_plane: None,
            media_plane: None,
            media_feedback: None,
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
            fec_rs: None,
            audio: None,
            video_plane: None,
            media_plane: None,
            media_feedback: None,
        };
        let s2 = String::from_utf8(f2.encode().unwrap()).unwrap();
        assert!(!s2.contains("uno_pass"));
        assert_eq!(RcFrame::decode(s2.as_bytes()).unwrap(), f2);
    }

    #[test]
    fn media_feedback_capability_is_independent_of_media_plane() {
        // 上一轮版本支持独立视频流，却没有媒体 ACK；不能把两个能力混为一谈。
        let old = br#"{"t":"request","capability":"view","media_plane":true}"#;
        assert!(matches!(RcFrame::decode(old).unwrap(), RcFrame::Request {
            media_plane: Some(true), media_feedback: None, ..
        }));
        let new = br#"{"t":"request","capability":"view","media_plane":true,"media_feedback":true}"#;
        assert!(matches!(RcFrame::decode(new).unwrap(), RcFrame::Request {
            media_plane: Some(true), media_feedback: Some(true), ..
        }));
        #[derive(Deserialize)]
        #[serde(tag = "t", rename_all = "snake_case")]
        enum Legacy { Request { capability: Capability, media_plane: Option<bool> } }
        assert!(matches!(serde_json::from_slice::<Legacy>(new).unwrap(), Legacy::Request {
            capability: Capability::View, media_plane: Some(true)
        }));
    }

    #[test]
    fn request_with_uno_code_roundtrip() {
        let f = RcFrame::Request {
            capability: Capability::View,
            uno_code: Some("AB2C-3DEF".into()),
            uno_pass: None,
            vid_dgram: None,
            fec_rs: None,
            audio: None,
            video_plane: None,
            media_plane: None,
            media_feedback: None,
        };
        let b = f.encode().unwrap();
        assert_eq!(RcFrame::decode(&b).unwrap(), f);
        // 旧版对端发来的 Request 没有 uno_code/uno_pass 字段，也要能解（default 补 None）
        let old = r#"{"t":"request","capability":"control"}"#.as_bytes();
        match RcFrame::decode(old).unwrap() {
            RcFrame::Request { capability, uno_code, uno_pass, vid_dgram, fec_rs, audio, video_plane, media_plane, media_feedback } => {
                assert_eq!(capability, Capability::Control);
                assert_eq!(uno_code, None, "旧对端没有这个字段，反序列化补 None");
                assert_eq!(uno_pass, None, "固定密码位同理（方案 C）");
                assert_eq!(vid_dgram, None, "能力位同理");
                assert_eq!(fec_rs, None, "RS FEC 能力位同理（P3.1）");
                assert_eq!(audio, None, "音频申请位同理（G3）");
                assert_eq!(media_plane, None);
                assert_eq!(media_feedback, None);
                assert_eq!(video_plane, None, "视频独立通道位同理（传输分 plane）");
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
