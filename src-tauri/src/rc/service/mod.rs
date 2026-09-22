//! 远程电脑服务层（方案 A：与同步配对/通道分离）。
//!
//! # 🔴 不认识 tauri
//!
//! 与 `sync/` 同一条界线。身份仍是共用的 `NodeIdentity`，
//! 但**设备信任表是 `rc_devices`**，通道在 `rc_enabled` 时自建 Endpoint。

use super::clipboard::{ClipWait, ClipboardState};
use super::discovery::{Discovery, PairedFn};
use super::join::{self, RcJoins};
use super::link::LinkState;
use super::net::{accept_loop, bind_rc_endpoint};
use super::notify::{NotifyFn, NotifyState, PathNotifyFn, ScopeNotifyFn};
use super::protocol::{Capability, RcFrame, SessionPhase, ALPN};
use super::session::{
    can_transition, gate_inbound, gate_outbound, new_session_id, Gate, Session, SessionSnapshot,
    CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED,
};
use super::stream_cfg::{
    auto_from_cfg, codec_from_cfg, profile_from_cfg, virtual_screen_from_cfg, StreamCfg, StreamOpts,
};
use super::uno;
use super::unop;
use crate::data_store::DataStore;
use crate::sync::identity::NodeIdentity;
use crate::sync::presence::{self, PresenceApp, PresenceTable, PORT as PRESENCE_BASE_PORT};
use iroh::{Endpoint, EndpointAddr};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 剪贴板推送上限：按 **JSON 帧 UTF-8 字节**卡（控制帧 64KB，留余量）。
/// 中文 1 字 ≈ 3 字节，不能按字符数卡。
pub(crate) const CLIPBOARD_MAX_JSON_BYTES: usize = 48 * 1024;

/// 剪贴板载荷是否在上限内（P1-12）。
///
/// 🔴 **唯一量纲是编码后 JSON 字节**。出站（[`RcService::push_clipboard`]）
/// 与入站/回包（`inbound.rs`）曾一处按 `json.len()`、两处按 raw `text.len()`——
/// 中文下两边尺子不一致：出站放行的会被入站拒掉，或入站放行后写出超帧。
/// 三处全部收口到本函数，判的是**同一份 JSON 编码后的长度**。
pub(crate) fn clip_payload_ok(json_bytes: usize) -> bool {
    json_bytes <= CLIPBOARD_MAX_JSON_BYTES
}

/// `ClipboardPush` 帧编码后字节数。出站预检与入站校验共用同一把尺子。
/// 序列化失败时返回 `usize::MAX`（= 一律拒），不静默放行。
pub(crate) fn clip_push_json_bytes(text: &str) -> usize {
    serde_json::to_vec(&super::input::InputEvent::ClipboardPush {
        text: text.to_string(),
    })
    .map(|b| b.len())
    .unwrap_or(usize::MAX)
}

/// `clip` 回包编码后字节数（入站 pull 回包校验用，与发送帧同构）。
/// 序列化失败时返回 `usize::MAX`（= 一律拒）。
pub(crate) fn clip_pull_json_bytes(text: &str) -> usize {
    serde_json::to_vec(&serde_json::json!({ "t": "clip", "text": text }))
        .map(|b| b.len())
        .unwrap_or(usize::MAX)
}
/// 拉回剪贴板时等回包的总时长。
const CLIPBOARD_PULL_TIMEOUT_MS: i64 = 4_000;

/// 待确认入站申请表（`Inner::pending`）的硬上限（D10）。
///
/// 灌它的前提是「已配对设备」，且入队按 peer 去重，所以现实中要撑爆得先凑够一批
/// 已配对的 node_id——当前不是可达的攻击面。加这道闸是为了不让「无上限」这件事
/// 留在代码里靠推理成立：真出现异常时表会停在这个尺寸并留一条 warn。
const PENDING_KNOCK_MAX: usize = 8;

/// 被控端配置键。
pub const CFG_QUALITY: &str = "rc_quality";
/// `virtual` | `primary`
pub const CFG_CAPTURE_SCOPE: &str = "rc_capture_scope";
/// `auto` | `jpeg` | `h264` — R4 硬编开关
pub const CFG_CODEC: &str = "rc_codec";
/// 发起端「码率倍率」（Q5，50–200，100 = 跟随链路）。会话建立时推给被控端。
pub const CFG_BITRATE_PCT: &str = "rc_bitrate_pct";

/// RC 地址宣告端口。**不是**同步的 5008，两套 presence 互不抢 bind。
pub const RC_PRESENCE_PORT: u16 = PRESENCE_BASE_PORT + 1;

/// 给界面看的完整状态。
/// [`RcService::uno_admit`] / [`RcService::pass_admit`] 的结局。`Denied` 带着
/// 回给对端的 (话, 稳定错误码)，语义与 `Gate::deny_reason` / `deny_code` 一致。
/// `pub(super)` 只为 `rc::tests` 能引用这个类型名（它经 `pass_admit` 的返回
/// 类型出现，private 会把函数一并锁死在 crate 内）。
pub(super) enum UnoAdmit {
    Admitted,
    Denied(String, String),
}

/// 建立入站会话的**信任来源**（[`RcService::establish_inbound_with`] 的门禁入参）。
///
/// 常规两条路（人工批准 / 方案 D 免确认直连）走到那一步时，对方必然已在
/// 白名单里——人工批准的前提是能敲门（`has_remote_trust` 为真才进 pending），
/// 免确认开关本身也只能开在已配对设备上——所以 `has_remote_trust` 这道闸
/// 对它们是成立的复核。
///
/// 无人值守的码 / 密码两条路是**唯一**的例外：信任来自「此刻刚验过的凭证」，
/// 不来自白名单行。因为写白名单这件事本身必须发生在会话真的建立**之后**
/// （2026-09-22 审计 D1：落点早于会话建立，等于让「码对但本机忙」这种失败
/// 也留下一行凭空多出来的白名单，且未 consume 前一个码能被多台设备洗进表里）。
/// 本枚举存在的理由不是放宽，而是让「先建会话、后落白名单」这个顺序在类型上
/// 说得清楚、且在新增调用点时不会有人随手写成默认那条。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum InboundTrust {
    /// 信任来自白名单行，门禁按原样复核。
    Whitelist,
    /// 信任来自刚验过的凭证（接入码 / 固定密码），放行白名单那一条。
    Credential,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RcStatus {
    pub enabled: bool,
    pub capability: String,
    pub session: Option<Session>,
    pub pending: Vec<InboundKnock>,
    /// 生成邀请后、等对方核对指纹敲门的列表。
    pub joins: Vec<join::RcJoinRequest>,
    /// 在效的无人值守接入码摘要（Q2）。只给过期时间/档位，**绝不含码本身**。
    pub uno: Vec<uno::UnoInfo>,
    /// 无人值守固定密码的当前状态（Q2 方案 C）。None = 未开启。
    /// 只给能力档/跨网开关/开启时刻，**绝不含密码本身或其哈希**。
    pub uno_pass: Option<unop::UnoPassInfo>,
    pub device_deny: HashMap<String, bool>,
    /// 通道是否已起来（rc_enabled 且端点绑定成功）。
    pub running: bool,
    /// 画质档 auto/uhd/ultra/sharp/balanced/smooth（auto = 被控端自动换档，2A）
    pub quality: String,
    /// 自动档当前**实际生效**的档位（流畅/均衡/清晰/超清之一）。
    /// 非 auto 档时与 `quality` 相同。前端 HUD / 设置页用它显示真实档。
    pub active_quality: String,
    /// 截取范围 virtual/primary
    pub capture_scope: String,
    /// 发起端「码率倍率」（Q5，50–200，100 = 跟随链路）。会话 UI 下拉初值。
    pub bitrate_pct: u32,
    /// 发起端最近 RTT（毫秒），0=尚未测到。
    pub rtt_ms: i64,
    /// 发起端本端丢包率（‰，EMA）；0 = 尚未采样。HUD 显示「丢包 x.x%」。
    pub loss_permille: u32,
    /// 会话链路实际走的路：`lan` / `direct` / `relay`；空串 = 未测到（前端不显示这格）。
    pub path_kind: String,
    /// 时钟偏差（被控端时钟 − 发起端时钟，ms，EMA）。发起端算「画面延迟」用：
    /// 帧龄 = 本地时刻 − (帧采集时刻 − 偏差)。0 = 尚未校准（两机时钟差未知）。
    pub clock_skew_ms: i64,
    /// 发起端视角：被控端是否支持 fps120（P1 caps）。被控端视角恒 false（本机档看本地能力）。
    pub peer_fps120: bool,
    /// 发起端视角：被控端是否支持 HEVC 硬编（Q3 caps）。
    pub peer_hevc: bool,
    /// 发起端视角：被控端主屏刷新率（Hz）。0 = 未上报。
    pub peer_refresh_hz: u32,
    /// 发起端视角：被控端在线显示器列表（Q7 caps）。空 = 未上报（旧版本对端）。
    pub peer_monitors: Vec<crate::screenshot::MonitorInfo>,
    /// 发起端视角：被控端是否声明「能读鼠标移动数据报」（R3 caps）。
    /// false = 未上报（官方 7.2.1 及更早）——发起端 UI 据此提示升级对端；
    /// **不改传输**（MouseMove 仍走数据报，旧对端收不到是已知限制）。
    pub peer_dgram_input: bool,
    /// 最后一次收到对端 pong 的时刻（epoch ms）；0 = 本会话还没收到过。
    ///
    /// 🔴 前端**只**用它判链路活性。ping 的本地 `invoke` 成功只说明消息进了
    /// 本地发送队列，不代表对端收到了——那是 2026-09-17 修掉的另一个误报源。
    pub last_pong_ms: i64,
    /// 非阻塞发起申请的后台失败原因；前端展示后应调 clear_outbound_error。
    pub outbound_error: Option<String>,
    /// 发起端：自动重连进度（Q6）。None = 没有。前端据此展示「正在重连 N/M」。
    pub reconnecting: Option<RcReconnectInfo>,
    /// G3：被控端**本机**是否已静音系统声音（被控者自己在横幅上关的）。
    ///
    /// 与「对端开关」是两件事：这个为 true 时，对端开不开都听不到。跨会话保持，
    /// 所以会话结束后仍可能为 true（下次被控时横幅按钮仍是「已静音」态）。
    pub audio_local_mute: bool,
    /// G3-B/C：**对端**报来的主机音频状态（发起端视角）。`None` = 旧对端不发这条帧
    /// （或本会话还没收到）→ 前端据此不摆「对方已静音」这类断言。
    pub peer_audio: Option<PeerHostAudio>,
    /// G3-C：对端静音了**本机**扬声器（被控端视角，横幅提示 + 恢复入口用）。
    ///
    /// 只反映「对端做过这个动作且没人撤销」——本机用户自己按静音键**不会**置位
    /// （我们不监听系统静音变化），所以它不声称等于扬声器当前物理态。
    pub spk_muted_by_peer: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InboundKnock {
    pub peer: String,
    pub peer_name: String,
    pub capability: Capability,
    pub first_seen_ms: i64,
}

struct Running {
    endpoint: Endpoint,
    presence: Arc<PresenceTable>,
    /// accept 循环停止标志：true = 退出。
    stop: Arc<AtomicBool>,
    /// presence 的 running（true = 在跑）；stop 时置 false。
    presence_running: Arc<AtomicBool>,
    #[allow(dead_code)]
    identity: Arc<NodeIdentity>,
}

/// 会话编排中枢。
///
/// 可见性说明：带 `pub(super)` 的字段不是「随手放开」——会话生命周期方法
/// （`end_session` / `force_end_if_session` / `require_active` …）实现在
/// `session.rs` 的 `impl RcService` 里，与状态机转移表同处一个文件；它们要
/// 直接碰这几样状态。四个子结构体（`clip` / `notify` / `stream` / `pressed`
/// 的内部字段）仍然私有，只能走各自的方法。
pub struct RcService {
    pub(super) store: DataStore,
    pub(super) inner: Mutex<Inner>,
    running: Mutex<Option<Running>>,
    joins: Arc<RcJoins>,
    /// 局域网配对的接线（附近设备 + 明文包收发），见 `discovery.rs`。
    ///
    /// 与 `running` 分开持有：通道没起时它也在，只是 `armed` 为空、列不出邻居；
    /// 界面上「附近设备」为空的事实来自这里，而不是来自一个「没人管的状态」。
    discovery: Arc<Discovery>,
    /// 发起端最近一帧（合成后）画面。
    last_frame: Mutex<Option<super::video::VideoFrame>>,
    /// 发起端帧出站队列（[`super::video::FrameOutbox`]）：H.264 P 帧与 JPEG
    /// 脏块帧不能丢、不能乱序，前端经 `rc_drain_frames` 按序批量取走；
    /// `last_frame` 槽位只是 latest-wins，留给旧命令 `rc_latest_frame` 兜底。
    frame_outbox: Mutex<super::video::FrameOutbox>,
    /// 发起端 → 被控端的发送半流（R2 键鼠 / R3 剪贴板）。tokio Mutex：跨 await 持锁。
    pub(super) outbound_send: tokio::sync::Mutex<Option<iroh::endpoint::SendStream>>,
    /// 发起端本会话的连接句柄：鼠标移动走 QUIC 数据报（P0-3）要用它。
    pub(super) outbound_conn: tokio::sync::Mutex<Option<iroh::endpoint::Connection>>,
    /// 发起端最近实测丢包率（‰，EMA）——HUD 显示（P0-4）。
    remote_loss_permille: std::sync::atomic::AtomicU32,
    /// 发起端：被控端上报的 fps120 可用性（P1 caps 控制帧）。false = 不可用/未上报。
    peer_fps120: std::sync::atomic::AtomicBool,
    /// 发起端：被控端主屏刷新率（Hz）。0 = 未上报。
    peer_refresh_hz: std::sync::atomic::AtomicU32,
    /// 发起端：被控端在线显示器列表（Q7 caps 控制帧带几何信息）。
    /// 空 = 未上报或对端是旧版本——会话 UI 据此决定出不出逐屏选项。
    peer_monitors: Mutex<Vec<crate::screenshot::MonitorInfo>>,
    /// 发起端：被控端是否支持 HEVC 硬编（Q3 caps）。false = 不可用/未上报。
    peer_hevc: std::sync::atomic::AtomicBool,
    /// 发起端：被控端 caps 是否声明 `dgram_input`（R3）。false = 旧版/未上报。
    peer_dgram_input: std::sync::atomic::AtomicBool,
    /// 剪贴板同步的状态与「跨会话串扰」不变量（见 `clipboard.rs`）。
    clip: ClipboardState,
    /// G6 文件传输的状态（待响应请求 + 任务列表，见 `file_state.rs`）。
    ///
    /// 与 `clip` 同一种收法：**字段 / 判据 / 作废入口三者同文件**。文件通道
    /// 独立于 RC 会话（独立 ALPN），所以这里没有「会话代」概念，只有任务 id——
    /// 断连由 `file_transfer.rs` 显式收口。
    pub(super) file: super::file_state::FileState,
    /// 被控端：推 JPEG 时的发送半流（End 帧用；发起端走 outbound_send）。
    pub(super) inbound_send:
        tokio::sync::Mutex<Option<std::sync::Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>>>,
    /// 状态变化 / 画面范围变化 / 注入错误 三类前端通知的收口（见 `notify.rs`）。
    pub(super) notify: NotifyState,
    /// 发起申请后台拨号失败（非阻塞 request）。status() 读出后由前端展示。
    pub(super) last_outbound_error: Mutex<Option<String>>,
    /// 发起端：自动重连 episode 状态（Q6）。None = 没有进行中/待展示的自动重连。
    /// 由 session.rs 的 `begin_auto_reconnect` 驱动；用户手动发起/结束会清掉。
    pub(super) auto_reconnect: Mutex<Option<AutoReconnect>>,
    /// episode 代次发生器（配 [`AutoReconnect::epoch`]，见 session.rs）。
    pub(super) reconnect_epoch: std::sync::atomic::AtomicU64,
    /// 无人值守接入码的内存待验表（Q2 方案 B，见 `uno.rs`）。
    /// 只存摘要、不落盘——进程活着码才活着。
    pub uno: uno::UnoCodes,
    /// 固定密码的防爆破闸（Q2 方案 C，见 `unop.rs`）：每对端指数退避 +
    /// 连续 5 次失败锁 10 分钟。纯内存，随进程生灭——密码哈希是持久的，
    /// 这个闸不必持久（重启清零最坏只是攻击者重吃一轮退避）。
    pub(super) pass_gate: unop::BruteGate,
    /// 推流参数（画质 / 截取范围 / 强制 JPEG）+ RTT（见 `stream_cfg.rs`）。
    stream: StreamCfg,
    /// 会话链路：数据走哪条路 + 心跳新鲜度（见 `link.rs`）。
    ///
    /// ❗ 与 `stream` 的 `last_rtt_ms` 刻意分开：那个供**码率自适应**用
    ///   （数值本身是目的），这个供**界面判定活性**用（「收到过 pong」这个
    ///   事实才是目的）。合并成一个数字会丢掉「什么时候收到的」。
    pub(super) link: LinkState,
    /// 被控端：当前被按住的 vk / 鼠标键集合，会话收口时补发 up（防止 Ctrl/Shift/鼠标键卡死）。
    pub(super) pressed: std::sync::Mutex<super::pressed::Pressed>,
    // ── G3 音频 ──
    /// 发起端：音频收流状态（cfg + 待取包）。accept_uni 的音频流写入，
    /// `rc_drain_audio` 命令取走。
    #[cfg(target_os = "windows")]
    audio_rx: Mutex<super::audio::AudioRx>,
    /// 被控端：对端申请了系统声音（Request.audio）。false = 旧对端 / 对端关声音。
    #[cfg(target_os = "windows")]
    audio_peer_wants: std::sync::atomic::AtomicBool,
    /// 被控端：**对端**会话中开关的镜像（对端 AudioOn(false) 置位；worker 每轮读）。
    ///
    /// ❗ 名字叫 muted，语义其实是「对端此刻想不想要」——**不是**「本机给不给」。
    /// 本机自己的意愿在 [`audio_local_mute`](Self::audio_local_mute)：两者都与
    /// `audio_peer_wants` 相与（见 `audio_wanted`），任一为否即不出声。
    #[cfg(target_os = "windows")]
    audio_muted: std::sync::atomic::AtomicBool,
    /// 被控端：**本机**静音（被控者自己在横幅上关的）。一票否决——对端开着也不出声。
    ///
    /// **跨会话保持**：这是隐私意愿，不做自动回退（关了就是关了，下次会话仍是关），
    /// 只有被控者自己再点开才恢复；不落盘，重启应用回到默认「可被听」。
    #[cfg(target_os = "windows")]
    audio_local_mute: std::sync::atomic::AtomicBool,
    /// 发起端：从对端 `host_audio` 帧收到的**对方主机侧音频状态**（G3-B/C）。
    /// None = 还没收到（旧对端不发这条帧）。
    pub(super) peer_host_audio: Mutex<Option<PeerHostAudio>>,
    /// 被控端：**对端**把本机扬声器静音了、且尚未恢复（G3-C）。
    ///
    /// 与「扬声器此刻是否静音」不是一回事：本机用户自己按静音键**不会**置位
    /// （我们不监听系统静音变化，见 `MEMORY-rc`），所以它回答的是「对端做过这个
    /// 动作且没人撤销」，用来决定横幅上那条提示与「恢复声音」按钮摆不摆。
    pub(super) spk_mute_by_peer: std::sync::atomic::AtomicBool,
}

/// 发起端侧看到的「对端主机音频状态」（G3-B/C，见 `RcService::peer_host_audio`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PeerHostAudio {
    /// 对端被控者按了「不发送声音」。
    pub local_mute: bool,
    /// 对端**主机扬声器**静音中。
    pub spk_mute: bool,
    /// 上一次切换动作的失败原因（对端执行失败时带；成功/未操作 = None）。
    /// 摆在快照里而不是 stream note：note 的文案分支属于**被控端横幅**，
    /// 发起端根本不渲染那个组件，借用它只会落进「对方把画质调成了…」的错文案。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

/// 发起端「免确认设备断线自动重连」的一轮重试 episode 的**内部**状态（Q6）。
/// 前端看到的是 [`RcReconnectInfo`]（status 里拼出来的投影）。
#[derive(Debug)]
pub struct AutoReconnect {
    pub peer: String,
    pub peer_name: String,
    pub capability: super::protocol::Capability,
    /// 已尝试次数（1 起；0 = 首次 sleep 还没醒）。
    pub attempt: u32,
    pub max: u32,
    /// 次数用尽。留着给 UI 显示「自动重连失败」，用户下一次手动动作时清。
    pub gave_up: bool,
    /// 🔴 episode 代次凭证（2026-09-19 审查 P2）：重连任务睡醒后凭它确认
    /// 「这段状态还归我管」。曾只认 peer——旧任务睡眠期间用户手动重连
    /// 成功又断流、新 episode 建立时，旧任务醒来误把新状态当成自己的，
    /// 两个任务并行重试、attempt 互相踩。
    pub epoch: u64,
}

/// status 里给前端的自动重连进度（Q6）。
#[derive(Debug, Clone, Serialize)]
pub struct RcReconnectInfo {
    pub peer: String,
    pub peer_name: String,
    /// 原会话的能力档（「重连失败」时前端「重新发起」按钮复用它）。
    pub capability: String,
    pub attempt: u32,
    pub max: u32,
    pub gave_up: bool,
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) session: Option<Session>,
    pub(super) pending: Vec<InboundKnock>,
    /// 被控端推流任务的所有权标记：同一 peer 双连接敲门时（旧版重试/网络抖动
    /// 都可能造出第二条连接），批准后两个等待循环都会看到 `InboundActive`——
    /// 不加这道闸就会 spawn 两个 InboundVideo（双份采集编码 CPU、`inbound_send`
    /// 槽互相覆盖）。第一个抢到的循环负责推流，其余连接在 Err 分支被拒。
    /// 建会话时置 false、end_session 清 session 时一并清。
    pub(super) inbound_streaming: bool,
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 「这台机器远程可信任」的判据：`rc_devices` ∪ 同步 `devices`（方案 A 的单向继承）。
///
/// 🔴 **只有这一处定义。** 三个消费者必须用同一个判据，否则会出现「地址表里有、
/// 附近列表里没有」这种用户无法解释的现象：
/// - presence 收包侧：要不要收它的地址公告（[`PresenceStart::is_paired`]）
/// - 局域网配对侧：附近设备列表要不要列它（`discovery.rs`）
///
/// 原先（2026-09-17 之前）这段逻辑只写在 presence 那一个闭包里；
/// 加局域网配对时抽出来，避免第二个副本。
fn rc_paired_fn(store: &DataStore) -> PairedFn {
    let s = store.clone();
    Arc::new(move |id: &str| {
        matches!(s.rc_device_get(id), Ok(Some(_))) || matches!(s.device_get(id), Ok(Some(_)))
    })
}

static GLOBAL: OnceLock<Arc<RcService>> = OnceLock::new();

pub fn install_global(svc: Arc<RcService>) {
    let _ = GLOBAL.set(svc);
}

pub fn global() -> Option<Arc<RcService>> {
    GLOBAL.get().cloned()
}

/// 会话失败时，把**对端主动关闭的理由**拼进错误里。
///
/// # 🔴 为什么必须走 `close_reason()`，而不是看错误字符串
///
/// noq 的 `ReadError::ConnectionLost` 的 Display **写死成 `"connection lost"`**
/// （`noq-1.2.0/src/recv_stream.rs:644`），**不插值内层的 `ConnectionError`**。
/// 于是对端以任何理由关连接，发起端读流时看到的永远只有
/// `读帧长度失败：connection lost`——上层那套分档（`src/lib/rcDeny.ts` 的
/// `not_paired / busy / disabled / channel_down`）在**发起失败**这条路径上
/// 全部退化成同一句兜底文案，界面只能猜「对方是不是关机了」。
///
/// 这一手同步侧早就补过（`sync::session::explain`，2026-09-06），
/// 远程电脑这条路径一直漏着。2026-09-17 排障时用户看到的
/// 「连接对端时中途断开 / 对方可能刚好关机、切网」就是这么来的：
/// 真正的原因是对端 QUIC 因 ALPN 不匹配直接拒绝，跟关机无关。
///
/// 不去 match 枚举而直接用 Display：`ConnectionError::ApplicationClosed` 的
/// Display 是 `"closed by peer: {reason} (code N)"`，reason 就在里面。
/// `pub(super)` 是给 `outbound.rs`（发起端收流循环）用的——它断流时同样要拼。
pub(super) fn explain(conn: &iroh::endpoint::Connection, err: String) -> String {
    match conn.close_reason() {
        // 还没关（本地逻辑错误、超时等）就原样往上报。
        None => err,
        Some(e) => format!("{}（{}）", err, e),
    }
}

/// 回一帧 Deny，然后**优雅地**关掉连接。
///
/// 🔴 为什么不写成「发完帧就 `return`」、让 `Connection` 随作用域 drop：
/// drop 走的是**立即关闭**，对端可能还没把帧读完就收到 CONNECTION_CLOSE，
/// 于是理由全丢。这里多做两件事：
/// ① `finish()` 告诉对端「数据发完了」——Deny 帧只有几十字节，会先到；
/// ② `close(code, reason)` 把理由**写进关闭帧**——即便 Deny 帧本身丢了，
///    对端的 [`explain`] 也能从 `close_reason()` 里把原因读出来。
///
/// 两条腿都留着是因为 UDP 上任何一个包都可能丢；只留一条，失败时就退化成
/// 「connection lost」——正是这次要修的症状。
async fn deny_and_close(
    conn: &iroh::endpoint::Connection,
    send: &mut iroh::endpoint::SendStream,
    reason: &str,
    code: &str,
) {
    // ❗ 先绑成变量再 `.encode()`：`if let Ok(b) = RcFrame::Deny { .. }.encode()`
    //   编译不过（`if let` 的条件位置不允许结构体字面量，rustc 会报
    //   "struct literals are not allowed here"）。
    let frame = RcFrame::Deny {
        reason: reason.to_string(),
        code: Some(code.to_string()),
    };
    if let Ok(bytes) = frame.encode() {
        let _ = crate::sync::transport::write_frame(send, &bytes).await;
    }
    let _ = send.finish();
    conn.close(1u32.into(), format!("[{}] {}", code, reason).as_bytes());
}

impl RcService {
    pub fn new(store: DataStore) -> Self {
        let joins = RcJoins::new();
        // 局域网配对与 presence 收包共用同一个「已配对」判据
        // （见 `rc_paired_fn` 的注释：两个副本迟早对不上）。
        let discovery = Discovery::new(store.clone(), joins.clone(), rc_paired_fn(&store));
        Self {
            store,
            inner: Mutex::new(Inner::default()),
            running: Mutex::new(None),
            joins,
            discovery,
            last_frame: Mutex::new(None),
            frame_outbox: Mutex::new(super::video::FrameOutbox::new()),
            outbound_send: tokio::sync::Mutex::new(None),
            outbound_conn: tokio::sync::Mutex::new(None),
            remote_loss_permille: std::sync::atomic::AtomicU32::new(0),
            peer_fps120: std::sync::atomic::AtomicBool::new(false),
            peer_refresh_hz: std::sync::atomic::AtomicU32::new(0),
            peer_monitors: Mutex::new(Vec::new()),
            peer_hevc: std::sync::atomic::AtomicBool::new(false),
            peer_dgram_input: std::sync::atomic::AtomicBool::new(false),
            clip: ClipboardState::new(),
            file: super::file_state::FileState::new(),
            inbound_send: tokio::sync::Mutex::new(None),
            notify: NotifyState::new(),
            last_outbound_error: Mutex::new(None),
            auto_reconnect: Mutex::new(None),
            reconnect_epoch: std::sync::atomic::AtomicU64::new(0),
            uno: uno::UnoCodes::default(),
            pass_gate: unop::BruteGate::default(),
            stream: StreamCfg::new(),
            link: LinkState::new(),
            pressed: std::sync::Mutex::new(super::pressed::Pressed::new()),
            #[cfg(target_os = "windows")]
            audio_rx: Mutex::new(super::audio::AudioRx::default()),
            #[cfg(target_os = "windows")]
            audio_peer_wants: std::sync::atomic::AtomicBool::new(false),
            #[cfg(target_os = "windows")]
            audio_muted: std::sync::atomic::AtomicBool::new(false),
            #[cfg(target_os = "windows")]
            audio_local_mute: std::sync::atomic::AtomicBool::new(false),
            peer_host_audio: Mutex::new(None),
            spk_mute_by_peer: std::sync::atomic::AtomicBool::new(false),
        }
    }

}

// —— impl RcService 按功能组平移到子模块（2026-09-22 体量合规）——
mod streaming;
mod notify_audio;
mod frames_clip;
mod trust;
mod lifecycle;
mod outbound;
mod inbound;
mod uno_pass;
mod inbound_accept;

pub fn cfg_enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_ENABLED).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}
