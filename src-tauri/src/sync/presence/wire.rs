//! 地址公告的**线上格式**：怎么把「我是谁、我在哪个端口、我属于哪一套、这份包
//! 想干什么」编码成一段字节，以及怎么把它验回来。
//!
//! 与 `super::table` 的分工：这里只管「字节 ↔ 结构」；一个包**能不能收**、
//! 该记到哪张表，是表那边的事。
//!
//! 🔴 格式上的删减（不带 IP / 不加密）的理由写在 [`super`] 的模块说明里，
//! 改动本文件前先读那一节。
//!
//! ❗ 有一处**在 2026-09-17 被修订**：原先「不带设备名」是三条铁律之一，
//! 但那说的只是 [`WireKind::Addr`]（地址公告）。A3 新增的
//! [`WireKind::Hello`] **必须**带名字——否则「附近的设备」列表只有一串
//! 十六进制指纹，用户没法认。名字因此被收窄到一条明确的、不自欺的通道：
//! 只在招呼包里出现、只用于显示、截断到 [`NAME_MAX_CHARS`] 个字符，
//! 且界面上必须同时标出「可自称，以指纹为准」。

use crate::sync::identity::NodeIdentity;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// 线上格式版本。
pub(super) const WIRE_V: u8 = 1;

/// 超过这个大小的包在解析前直接丢——合法公告只有两百来字节。
pub(super) const MAX_PACKET: usize = 2048;

/// 时间戳允许的偏差（毫秒）。沿用 `lan_sync` 的 120 秒。
pub(super) const CLOCK_WINDOW_MS: i64 = 120_000;

/// 这份公告属于哪一套 presence。
///
/// 🔴 为什么需要它：同一个进程里跑着**两套** [`super::PresenceTable`]
/// （知识库同步 5008 / 远程电脑 5009），而两者的包除端口外**完全一样**——
/// 同一 `node_id`、同一把签名密钥、同一份 [`Wire`]。于是「端口写错一侧」的后果
/// 不是日志噪音，而是**静默污染**：包进错表、全套校验照常通过、地址表被写脏，
/// 而异常日志与正常心跳长得一模一样（2026-09-17 为此排查了半天）。
///
/// 有了这个字段，串台就变成一条明确的日志（[`super::Heard::WrongApp`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceApp {
    /// 知识库同步，[`super::PORT`]（5008）。
    Kb,
    /// 远程电脑，`rc::RC_PRESENCE_PORT`（5009）。
    Rc,
}

impl PresenceApp {
    /// 给人看的名字，进日志用。
    pub fn label(self) -> &'static str {
        match self {
            PresenceApp::Kb => "知识库同步",
            PresenceApp::Rc => "远程电脑",
        }
    }
}

/// 这份包想干什么。
///
/// 2026-09-17（A3）新增。在**同一个端口**上跑两种用途的包，靠这个字段分流：
/// [`Addr`](WireKind::Addr) 走原路（签名 → 查已配对 → 入地址表），其余是
/// **明文招呼与配对握手**，一个字都不进地址表，只进 [`super::Nearby`] 或
/// 远程电脑那边的配对会话。
///
/// # 🔴 `#[default]` 必须是 `Addr`，不能改
///
/// 旧版本发的包里**没有**这个字段，`serde(default)` 会把它们读成 [`Addr`]——
/// 也就是旧包按旧口径收下。反了的话，升级过渡期所有旧对端的地址公告都会被
/// 判成另一种包而丢掉，局域网发现整个失效。
///
/// # 🔴 这些包都签名，尽管内容是明文
///
/// 「明文」说的是**内容不加密**（同网段谁都能读到设备名，这是要列出附近设备的
/// 必要代价）。签名照旧带（覆盖的仍是 `node_id | port | ts`），理由有两条：
///
/// ① **旧版本不会因此报警**。旧版本的 `hear()` 只认得签名那套校验，
///    拿到不签名的包会走 `Heard::Bad("公告里的签名解不开")` → **每个招呼包一条 warn**。
///    带上签名，旧版本看它就是一份普通的地址公告（多出来的字段被 serde 忽略），
///    悄悄收下、不刷屏。
/// ② **挡住冒名**。没签名的话任何同网段的人都能宣告**别人的** `node_id`，
///    让用户看到一台名字对得上、指纹却是别人的设备。有签名，攻击者只能宣告自己。
///
/// 签名不覆盖 `name` / `pk` / `to_id`：被改的后果是「名字显示错」或
/// 「两端算出的 6 位数字不一样」——而后者正是用户要靠肉眼识破中间人的那条路
/// （见 `rc/pin.rs`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireKind {
    /// 地址公告：已配对设备之间报「我在哪个端口」。原路，行为完全不变。
    #[default]
    Addr,
    /// 明文招呼：自报设备名，用来列出「附近的设备」。不入地址表。
    Hello,
    /// 配对握手：发起方送上本次会话的临时公钥。
    PinReq,
    /// 配对握手：应答方回送自己的临时公钥。
    PinResp,
    /// 配对握手：某一侧点过「两边一样」之后，告诉对方「我这侧确认了」。
    PinOk,
}

impl WireKind {
    /// 是不是明文那几种（不进地址表的东西）。
    pub fn is_plain(self) -> bool {
        !matches!(self, WireKind::Addr)
    }

    /// 给人看的名字，进日志用。
    pub fn label(self) -> &'static str {
        match self {
            WireKind::Addr => "地址公告",
            WireKind::Hello => "附近招呼",
            WireKind::PinReq => "配对请求",
            WireKind::PinResp => "配对应答",
            WireKind::PinOk => "配对确认",
        }
    }
}

/// 设备名最长留几个字符（`Wire::name`）。
///
/// 这个名字**由对方自报、不可信**，而它会一路进到界面上，所以两头都要卡：
/// 这里截断（省得同网段的人塞一个几 KB 的字符串撑爆包），
/// 界面上标注「可自称，以指纹为准」（见 `RcNearbyList.tsx`）。
///
/// 32 个字符够任何真实机器名（设计稿里的基准名「办公室台式机」是 6 个字）。
pub const NAME_MAX_CHARS: usize = 32;

/// 线上格式。字段少得可疑——那是刻意的，见 [`super`] 模块说明 ①②。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Wire {
    pub(super) v: u8,
    /// 这份包想干什么。旧包没有这个字段 → [`WireKind::Addr`]（见该枚举的注释）。
    ///
    /// 放在 `v` 后面只是可读性上的顺位，JSON 字段顺序不影响解析。
    ///
    /// ❗ `skip_serializing_if` 在这里同样是为了兼容性而非省字节：`Addr` 是**默认值**，
    /// 不写出来的话升级前后地址公告的字节完全一致（`test_公告里没有设备名字段` 钉着它）。
    #[serde(default, skip_serializing_if = "is_addr")]
    pub(super) kind: WireKind,
    /// 宣告方的 `NodeId`（公钥 hex，64 字符）。
    pub(super) node_id: String,
    /// 宣告方 iroh 端点监听的端口。IP 由接收方从源地址取。
    pub(super) port: u16,
    /// 宣告时刻（epoch 毫秒）。参与签名，用来做窗口 + 单调检查。
    pub(super) ts: i64,
    /// 本公告属于哪一套 presence。**不参与签名**，取舍见 [`build`]。
    ///
    /// `Option` 是为了读得进**旧版本**发的包（那时还没有这个字段）——
    /// 旧包的 `app` 是 `None`，接收侧按旧口径收下并标注「对端待升级」。
    #[serde(default)]
    pub(super) app: Option<PresenceApp>,
    /// 仅 [`WireKind::Hello`]：对方**自报**的设备名。空 = 没带。
    ///
    /// 🔴 不可信：用来在列表里给人一个认得出的名字，**不是身份**。
    ///
    /// ❗ `skip_serializing_if` 不是省字节，是**兼容性本身**：地址公告（[`Addr`](WireKind::Addr)）
    ///   里这三样一律不出现，于是升级后每个地址公告的字节与升级前**一模一样**
    ///   （`test_公告里没有设备名字段` 钉着这一点）。旧对端收到的还是它认得的那个 JSON。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    /// 仅配对握手：本次会话的临时公钥（X25519，hex）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pk: Option<String>,
    /// 仅配对握手：这包给谁。空 = 没指定（招呼包就是这样）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) to_id: Option<String>,
    /// 仅 [`WireKind::PinOk`]：附加证明（HMAC-SHA256 hex）。
    ///
    /// 🔴 P1-1：签名只盖 `node_id|port|ts`（见 [`signing_bytes`]——不能扩，
    /// 会废掉与旧版互通），所以 `kind`/`pk`/`to_id` 在明文包上可被中间人
    /// **偷换**（拿任意一份合法签名包改成 `pin_ok` 冒充「我这侧确认了」）。
    /// 本字段是对配对会话 X25519 shared 的 HMAC，绑定
    /// `"pin-ok"|node_id|to_id|ts`——无 proof / 错 proof 一律不认。
    ///
    /// `skip_serializing_if`：地址公告与招呼包不带它，字节与升级前一致。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) ok_proof: Option<String>,
    /// 签名的 base64url。
    pub(super) sig: String,
}

/// [`WireKind::Addr`] 不进 JSON（见 [`Wire::name`] 那条注释）。
fn is_addr(k: &WireKind) -> bool {
    *k == WireKind::Addr
}

/// 握手包要带的东西。收成结构体是因为这里有**三个都是 `Option<String>` 的字段**
/// （`name` / `pk` / `to_id`），位置参数下写反了编译器不报错，
/// 只会表现为「名字显示成公钥」这种要从界面上往回猜的现象。
#[derive(Debug, Clone, Default)]
pub struct Extras {
    pub name: Option<String>,
    pub pk: Option<String>,
    pub to_id: Option<String>,
    /// 仅 [`WireKind::PinOk`]：HMAC 证明（见 [`Wire::ok_proof`]）。
    pub ok_proof: Option<String>,
}

impl Extras {
    /// 招呼包：只带名字。
    pub fn hello(name: &str) -> Self {
        Self {
            name: Some(name.to_string()),
            ..Default::default()
        }
    }

    /// 定向握手包：带公钥 + 目标。
    pub fn to(peer_id: &str, pk: &str) -> Self {
        Self {
            pk: Some(pk.to_string()),
            to_id: Some(peer_id.to_string()),
            ..Default::default()
        }
    }
}

/// 把对方自报的名字洗成能安全放进界面的样子。
///
/// 去掉首尾空白里的控制字符、按 [`NAME_MAX_CHARS`] 截断。**只做这一件事**——
/// 名字的权威性属于界面（标注「可自称」），不在这里假装过滤能解决冒名。
pub(super) fn clean_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 待签名的规范字节。
///
/// 🔴 用 `|` 分隔：三个字段分别是 hex、数字、数字，都不可能含 `|`，
/// 所以拼接无歧义。
///
/// 前缀与 [`super::super::invite`] 的**必须不同**，否则一份邀请码的签名可能被
/// 拿来当公告用（跨协议签名复用）。
///
/// 🔴 **`app` 故意不在这里**——见 [`build`] 的取舍说明。改这个函数前必读。
pub(super) fn signing_bytes(node_id: &str, port: u16, ts: i64) -> Vec<u8> {
    format!("pastepanda-presence-v1|{}|{}|{}", node_id, port, ts).into_bytes()
}

/// 做一份公告。
///
/// - `app`：本套 presence 的用途，接收侧用它认串台。
/// - `endpoint_port`：本机 iroh **端点**的监听端口（写进公告供对端拨号，
///   **不是**本套 presence 的组播端口）。
///
/// # 🔴 为什么 `app` 不参与签名
///
/// 纳入签名的版本更「安全」，但会**同时废掉跨版本互通**：签名字节一变，
/// 旧版本收到新版本的包必定验签失败。后果是升级过渡期**两个方向一起退到
/// n0 公共中继**——比「只修一半」（v7.2.1 当时的状况）还糟，等于用一次
/// 更严重的退化去换一个标识字段。
///
/// 不纳入签名的代价：中间人可以把这个字段改掉（比如把 kb 的包标成 rc）。
/// 危害上限是「让接收方把包放进另一张表」→ 白拨一次，QUIC 握手过不去。
/// 这与 [`super`] 模块说明里「认证边界在传输层」是同一套账：源 IP 与私钥
/// 都不是组播上能伪造的东西。
pub fn build(
    me: &NodeIdentity,
    app: PresenceApp,
    endpoint_port: u16,
    now_ms: i64,
) -> Result<Vec<u8>, String> {
    build_kind(
        me,
        app,
        WireKind::Addr,
        endpoint_port,
        now_ms,
        Extras::default(),
    )
}

/// 做一份**任意用途**的包（A3 的招呼包与配对握手包都走这里）。
///
/// `endpoint_port` 仍写进 `port` 字段并**参与签名**——哪怕招呼包其实用不到它。
/// 这样做是为了让旧版本把这些包认成一份普通的地址公告而不是坏包
/// （理由见 [`WireKind`] 的注释）。
pub fn build_kind(
    me: &NodeIdentity,
    app: PresenceApp,
    kind: WireKind,
    endpoint_port: u16,
    now_ms: i64,
    extras: Extras,
) -> Result<Vec<u8>, String> {
    let node_id = me.node_id();
    let sig = me.sign(&signing_bytes(&node_id, endpoint_port, now_ms))?;
    let wire = Wire {
        v: WIRE_V,
        kind,
        node_id,
        port: endpoint_port,
        ts: now_ms,
        app: Some(app),
        name: extras.name,
        pk: extras.pk,
        to_id: extras.to_id,
        ok_proof: extras.ok_proof,
        sig: b64().encode(sig),
    };
    serde_json::to_vec(&wire).map_err(|e| format!("序列化地址公告失败：{}", e))
}

/// base64url（无填充）。本文件内共用一份，对外只经 [`decode_sig`]。
fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// 解一个 base64url 签名。
///
/// ❗ 收口在这里是为了让 `base64::Engine` 这个 trait 只在本文件被 `use` 一次——
/// 直接调 `b64().decode(..)` 的调用方必须自己 `use base64::Engine`，
/// 漏了会报 `no method named decode`，而错误信息指向调用方而不是这里。
pub(super) fn decode_sig(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    b64().decode(s)
}
