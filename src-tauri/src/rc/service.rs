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
    can_transition, gate_inbound, gate_outbound, new_session_id, Gate, Session, CFG_CAPABILITY,
    CFG_DEVICE_DENY, CFG_ENABLED,
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
pub(super) const CLIPBOARD_MAX_JSON_BYTES: usize = 48 * 1024;
/// 拉回剪贴板时等回包的总时长。
const CLIPBOARD_PULL_TIMEOUT_MS: i64 = 4_000;

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

    /// RTT 变化通知链路层（`outbound.rs` 解析出 `t:"pong"` 后调用）。
    ///
    /// 一次调用喂两个消费者：RTT 数值进 `stream`（码率自适应要用），
    /// **「收到过 pong」这个事实**进 `link`（界面判活性的唯一证据）。
    ///
    /// 🔴 `rtt_ms <= 0` **不算** pong：那是会话开始 / 结束时的清零复位
    ///   （`note_rtt(0)` 在两个收尾点被调用）。不区分的话，会话一建立
    ///   界面就报「已连接」，把真正的首包延迟掩盖掉。
    pub fn note_rtt(&self, rtt_ms: i64) {
        self.stream.note_rtt(rtt_ms);
        // ❗ `rtt_ms == 0` 是**清零复位**（`end_session` 与发起失败路径都调它），
        //    不是一次测量 —— 别把它当成「收到 pong」，否则会话一建立界面就报
        //    「已连接」，把首包延迟掩盖掉。
        if rtt_ms > 0 {
            self.link.note_pong(rtt_ms);
        }
    }

    pub fn last_rtt_ms(&self) -> i64 {
        self.stream.rtt_ms()
    }

    /// 会话建立时用本机配置初始化推流参数。
    pub fn reset_stream_opts_from_cfg(&self) {
        let cfg = self.cfg();
        self.stream.reset_from_cfg(
            profile_from_cfg(&cfg),
            virtual_screen_from_cfg(&cfg),
            auto_from_cfg(&cfg),
            codec_from_cfg(&cfg),
        );
    }

    /// 发起端配置的码率倍率（Q5）。缺省 100 = 跟随链路；配置损坏按缺省算。
    pub(crate) fn user_bitrate_pct_from_cfg(&self) -> u32 {
        self.cfg()
            .get(CFG_BITRATE_PCT)
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(100)
        .clamp(50, 200)
    }

    /// 被控端：应用发起端推来的码率倍率（Q5，`SetBitratePct`）。
    pub fn set_user_bitrate_pct(&self, pct: u32) -> Result<(), String> {
        self.stream.set_user_bitrate_pct(pct)
    }

    /// 发起端在会话中改画质（五档实名或 "auto"）。
    pub fn set_stream_quality(&self, quality: &str) -> Result<(), String> {
        // D6：fps120 / uhd60 是能力档，API 层也要设防——UI 门控（visibleQualities）
        // 只挡得住正常路径，挡不住直连接口/旧前端的请求；放行会让主机用 CPU 管线
        // 按 8ms 硬跑。范围中途切到多屏的场景由推流循环的降档兜底（D6b）。
        if quality == "fps120" {
            #[cfg(target_os = "windows")]
            {
                let caps = super::gpu::encode_caps();
                if !caps.h264_gpu {
                    return Err("本机没有硬件 D3D11 编码器，fps120 档不可用".into());
                }
                if caps.refresh_hz < 100 {
                    return Err(format!(
                        "主屏刷新 {}Hz 不足 100Hz，fps120 档不可用",
                        caps.refresh_hz
                    ));
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("fps120 档仅支持 Windows".into());
            }
        }
        // Q4：uhd60 要求 HEVC 硬编——4K60 的 H.264 需要 L5.2（多数解码端跑不动
        // 或兼容性差），HEVC L5.1 即覆盖且同画质省一半带宽。没有 HEVC MFT 就
        // 诚实拒绝，不静默降成超规格流。
        if quality == "uhd60" {
            #[cfg(target_os = "windows")]
            {
                let caps = super::gpu::encode_caps();
                if !caps.h264_gpu {
                    return Err("本机没有硬件 D3D11 编码器，4K60 档不可用".into());
                }
                if !caps.hevc_hw {
                    return Err("本机没有硬件 HEVC 编码器，4K60 档不可用（H.264 无法稳定 4K60）".into());
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("4K60 档仅支持 Windows".into());
            }
        }
        self.stream.set_quality(quality)
    }

    /// 推流循环每帧喂一次画面字节数；自动档开启时据此换档（2A）。
    pub fn auto_note_frame(&self, bytes: usize) {
        self.stream.auto_note_frame(bytes, now_ms());
    }

    /// 自动档是否开启（status 组装用）。
    pub fn auto_enabled(&self) -> bool {
        self.stream.auto_enabled()
    }

    /// 自动档当前生效的档位名。
    pub fn auto_tier_name(&self) -> String {
        self.stream.auto_tier_name()
    }

    /// 会话收尾时复位推流侧的**会话级**状态（`end_session` 调）。
    ///
    /// 目前只有自动档：它与会话同生命周期，跨会话残留会让界面显示上一场
    /// 会话停留的档位（见 `StreamCfg::auto_reset`）。
    pub(super) fn reset_stream_after_session(&self) {
        self.stream.auto_reset();
    }

    /// 被控端：对端上报 RTT，返回当前 H.264 码率缩放（%）。
    pub fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        self.stream.set_peer_rtt(rtt_ms)
    }

    /// 被控端：QUIC stats 采样（推流任务）喂本端链路状况 → 码控（P0-4）。
    pub(super) fn note_stream_health(&self, rtt_ms: i64, loss_permille: i64) {
        self.stream.note_stream_health(rtt_ms, loss_permille);
    }

    /// 发起端：pong 带回的时钟偏差样本（P0-1 A3）。
    pub(super) fn note_clock_skew(&self, sample_ms: i64, rtt_ms: i64) {
        self.stream.note_clock_skew(sample_ms, rtt_ms);
    }

    pub(super) fn clock_skew_ms(&self) -> i64 {
        self.stream.clock_skew_ms()
    }

    /// 发起端：被控端上报的画面能力（P1 caps 控制帧）。UI 据此诚实出 fps120 档。
    /// Q3：caps 带 HEVC 硬编可用性；Q7：caps 顺带带上对端在线显示器列表。
    pub(super) fn note_peer_caps(
        &self,
        fps120: bool,
        refresh_hz: u32,
        hevc: bool,
        monitors: Vec<crate::screenshot::MonitorInfo>,
        dgram_input: bool,
    ) {
        self.peer_fps120
            .store(fps120, std::sync::atomic::Ordering::Relaxed);
        self.peer_refresh_hz
            .store(refresh_hz.min(1000), std::sync::atomic::Ordering::Relaxed);
        self.peer_hevc
            .store(hevc, std::sync::atomic::Ordering::Relaxed);
        self.peer_dgram_input
            .store(dgram_input, std::sync::atomic::Ordering::Relaxed);
        *self.peer_monitors.lock().unwrap_or_else(|p| p.into_inner()) = monitors;
    }

    pub fn peer_fps120(&self) -> bool {
        self.peer_fps120.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端视角：被控端是否支持 HEVC 硬编（Q3 caps）。
    pub fn peer_hevc(&self) -> bool {
        self.peer_hevc.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端视角：被控端 caps 是否声明可读鼠标数据报（R3）。false = 旧版。
    pub fn peer_dgram_input(&self) -> bool {
        self.peer_dgram_input.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn peer_refresh_hz(&self) -> u32 {
        self.peer_refresh_hz
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端：本端丢包率采样（收流任务）→ status/HUD（P0-4）。
    pub(super) fn note_remote_loss(&self, permille: u32) {
        self.remote_loss_permille
            .store(permille.min(1000), std::sync::atomic::Ordering::Relaxed);
    }

    pub fn bitrate_scale(&self) -> u32 {
        self.stream.bitrate_scale()
    }

    /// 发起端在会话中改截取范围。
    ///
    /// ⚠️ 这个入口**故意不发** `emit_scope_changed`：本机用户在设置页自己改范围
    /// 不该收到「有人改了你的画面范围」。只有入站路径
    /// （`handle_inbound_input` 的 `SetCaptureScope`）才通知。
    /// `rc/tests.rs` 有专门断言，搬动时别把通知顺手加进来。
    pub fn set_stream_scope(&self, scope: &str) -> Result<(), String> {
        self.stream.set_scope(scope)
    }

    /// 发起端：H.264 解不出时强制本会话走 JPEG；`codec=h264` 可再打开。
    pub fn set_stream_codec(&self, codec: &str) -> Result<(), String> {
        self.stream.set_codec(codec)
    }

    pub(super) fn stream_opts_snapshot(&self) -> StreamOpts {
        self.stream.snapshot()
    }

    pub fn touch_activity(&self) {
        self.stream.touch_activity(now_ms());
    }

    /// 是否应暂停推流：会话开始后长时间无心跳/输入。
    pub fn should_pause_stream(&self) -> bool {
        self.stream.should_pause(now_ms())
    }

    pub fn encode_profile(&self) -> super::video::EncodeProfile {
        profile_from_cfg(&self.cfg())
    }

    pub fn capture_virtual_screen(&self) -> bool {
        virtual_screen_from_cfg(&self.cfg())
    }

    /// 注入前端通知回调（lib.rs 在 manage 之后调用）。
    pub fn set_notify(&self, f: NotifyFn) {
        self.notify.set_notify(f);
    }

    /// 注入「outbox 有新帧」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_frame_notify(&self, f: NotifyFn) {
        self.notify.set_frame_notify(f);
    }

    pub(super) fn emit_changed(&self) {
        self.notify.emit_changed();
    }

    /// 注入「对端改了画面范围」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_scope_notify(&self, f: ScopeNotifyFn) {
        self.notify.set_scope_notify(f);
    }

    /// 注入「远端光标形状变化」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_cursor_notify(&self, f: super::notify::CursorNotifyFn) {
        self.notify.set_cursor_notify(f);
    }

    /// 注入文件传输状态回调（G6，lib.rs 在 manage 之后调用）。
    pub fn set_file_notify(&self, f: super::notify::FileNotifyFn) {
        self.notify.set_file_notify(f);
    }

    /// 被控端上报的光标形状变化 → 抛给发起端前端。
    pub(super) fn set_remote_cursor(&self, shape: String) {
        self.notify.emit_cursor_changed(&shape);
    }

    /// 注入「会话换路了」的回调（lib.rs 在 manage 之后调用）。
    ///
    /// C：iroh 每 60s 会尝试把中继路径升级成直连（`UPGRADE_INTERVAL`），
    /// 这个自动升级不通知的话用户只会看到延迟莫名变化。
    pub fn set_path_notify(&self, f: PathNotifyFn) {
        self.notify.set_path_notify(f);
    }

    /// 被控端：告诉前端「对端把画面范围改成了 scope」。
    ///
    /// B3：观察者（**包括只看会话**）能改被观察者的采集范围，被观察者原来只有
    /// `log::info`，UI 上完全看不到——观察者因此能把画面切到另一块屏（上面可能有
    /// 隐私内容）而对方毫无察觉。这里把变更显式抛给被控端 UI。
    ///
    /// ⚠️ 只有**入站**路径（`handle_inbound_input` 收到 `SetCaptureScope`）该调它。
    /// 本机自己在设置页改范围走 `set_stream_scope`，那条路径**故意不通知**——
    /// 用户自己点的操作不需要再弹一条「有人改了你的画面范围」。
    ///
    /// `pub(crate)` 是为了让 `rc::tests` 能覆盖「回调确实收到 scope」，
    /// 不是因为需要跨模块调用。
    pub(crate) fn emit_scope_changed(&self, scope: &str) {
        self.notify.emit_scope_changed(scope);
    }

    // ── G3 音频 ─────────────────────────────────────────────────────────

    /// 被控端：登记对端的音频申请（Accept 前调用）。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_set_peer_wants(&self, wants: bool) {
        self.audio_peer_wants
            .store(wants, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：对端是否申请了系统声音（音频任务只看这个决定起不起）。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_peer_wants(&self) -> bool {
        self.audio_peer_wants
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 音频此刻该不该出。三因子取与，任一为否即不出声：
    /// 对端申请了（Request.audio）&& 对端没在会话里关掉 && **本机没静音**。
    /// 采集 worker 每轮读，三者会话中任意时刻翻转都即时生效（停即关流、开即重发 Cfg）。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_wanted(&self) -> bool {
        self.audio_peer_wants.load(std::sync::atomic::Ordering::SeqCst)
            && !self.audio_muted.load(std::sync::atomic::Ordering::SeqCst)
            && !self.audio_local_mute.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 被控端：**对端**的开关（只由 `InputEvent::AudioOn` 驱动，不接本机 UI）。
    #[cfg(target_os = "windows")]
    pub fn set_audio_muted(&self, muted: bool) {
        self.audio_muted
            .store(muted, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：**本机**静音（被控者自己关的，一票否决）。跨会话保持，见字段注释。
    ///
    /// ❗ 只改状态，**不推帧**——推送是 async，而这里是同步方法且调用方就在命令层。
    /// 命令层改完必须跟一句 [`emit_host_audio`](Self::emit_host_audio)，否则对端
    /// 只会发现「声音没了」而不知道是对方静音（G3-B 要消掉的正是这个）。
    #[cfg(target_os = "windows")]
    pub fn set_audio_local_mute(&self, muted: bool) {
        self.audio_local_mute
            .store(muted, std::sync::atomic::Ordering::SeqCst);
    }

    /// 被控端：本机是否已静音。status 上报给前端画按钮态；与字段同名同
    /// `audio_peer_wants()` 的先例。
    #[cfg(target_os = "windows")]
    pub fn audio_local_mute(&self) -> bool {
        self.audio_local_mute
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 被控端：把本机音频状态推给对端（G3-B/C，控制流上一条 JSON，与 `cursor`/`clip` 同路）。
    ///
    /// 三个时机：**会话刚建立**（给初值，见 `inbound.rs` 的 `run`）、**被控者切
    /// 「不发送声音」**、**收到 `SetHostMute` 之后**（回读回的真实值）。
    ///
    /// `err` 只在动作失败时带——对端据此提示「切换失败」，而不是点了没反应。
    /// 没有控制流（未 Accept / 已断开）时静默返回：它不是关键路径。
    ///
    /// 可见性是 `pub` 是因为**命令层也要用**（被控者切「不发送声音」后必须跟着推）。
    pub async fn emit_host_audio(&self, err: Option<&str>) {
        #[cfg(target_os = "windows")]
        {
            let spk = super::audio::spk_mute_get().unwrap_or(false);
            let local = self.audio_local_mute.load(std::sync::atomic::Ordering::SeqCst);
            let mut msg = serde_json::json!({
                "t": "host_audio",
                "local_mute": local,
                "spk_mute": spk,
            });
            if let Some(e) = err {
                msg["err"] = serde_json::Value::String(e.to_string());
            }
            let Ok(b) = serde_json::to_vec(&msg) else {
                return;
            };
            let guard = self.inbound_send.lock().await;
            if let Some(send) = guard.as_ref() {
                let mut g = send.lock().await;
                let _ = crate::sync::transport::write_frame(&mut g, &b).await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = err;
        }
    }

    /// 发起端：记下对端报来的主机音频状态（`outbound.rs` 解出 `host_audio` 后调用）。
    pub(super) fn set_peer_host_audio(&self, st: PeerHostAudio) {
        *self.peer_host_audio.lock().unwrap_or_else(|p| p.into_inner()) = Some(st);
    }

    /// 发起端：对端报来的主机音频状态（快照用）。None = 旧对端不发这条帧。
    pub(super) fn peer_host_audio(&self) -> Option<PeerHostAudio> {
        self.peer_host_audio
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 被控端：对端静音了本机扬声器且尚未恢复（横幅提示 + 恢复入口摆不摆）。
    pub fn spk_muted_by_peer(&self) -> bool {
        self.spk_mute_by_peer.load(Ordering::SeqCst)
    }

    /// 被控端：记「对端静音了本机扬声器」。`false` = 已恢复，或本就是本机自己改的。
    pub fn set_spk_muted_by_peer(&self, on: bool) {
        self.spk_mute_by_peer.store(on, Ordering::SeqCst);
    }

    /// 被控端本机：设置主机扬声器静音，并把新状态告知对端（命令层入口）。
    ///
    /// 与「对端发 `SetHostMute`」的区别：**这是本机自己的操作**，所以顺手清掉
    /// 「对端静音的」标记（横幅提示与恢复按钮随之收起），并推一次状态帧——
    /// 否则对端那个按钮会停在一个已经不成立的状态上。返回读回的真实值。
    #[cfg(target_os = "windows")]
    pub async fn host_mute_local(&self, on: bool) -> Result<bool, String> {
        let actual = super::audio::spk_mute_set(on)?;
        self.set_spk_muted_by_peer(false);
        self.emit_host_audio(None).await;
        Ok(actual)
    }

    /// 发起端：音频流头部到了（新音频流开始）——替换缓冲。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_begin(&self, cfg: super::audio::AudioCfg) {
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .begin(cfg);
    }

    /// 发起端：音频包入队（满则丢最旧——声音要新鲜）。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_push(&self, pts_ms: u64, data: Vec<u8>) {
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(pts_ms, data);
    }

    /// 发起端：前端取音频（cfg 每次都带，前端按 asc 变了才重配解码器）。
    #[cfg(target_os = "windows")]
    pub fn drain_audio(&self) -> (Option<super::audio::AudioCfg>, Vec<super::audio::AudioPkt>) {
        let mut rx = self.audio_rx.lock().unwrap_or_else(|p| p.into_inner());
        (
            rx.cfg.clone(),
            rx.queue.drain(..).collect(),
        )
    }

    /// 会话收口：音频状态清零（对端申请位、对端开关、收流缓冲）。
    ///
    /// ❗ **不清 `audio_local_mute`**：它是被控者本人的隐私意愿，属于「跨会话保持」
    /// 的状态（字段注释里有理由）。会话结束顺手把它抹掉，等于每来一个人就把用户的
    /// 静音自动解开一次——隐私开关不该有这种自动回退。
    #[cfg(target_os = "windows")]
    pub(super) fn audio_reset(&self) {
        self.audio_peer_wants
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.audio_muted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.audio_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reset();
        // G3-B/C：两边的主机音频状态都是**本会话**的事实，会话收口即作废。
        // ❗ 唯独不动 `audio_local_mute`（被控者的隐私意愿，跨会话保持，见上）。
        *self.peer_host_audio.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.spk_mute_by_peer
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 注入「对端改了画质/编码」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_stream_notify(&self, f: super::notify::StreamNotifyFn) {
        self.notify.set_stream_notify(f);
    }

    /// 被控端：告诉前端「对端把画质/编码改成了 name」。
    ///
    /// Q10：对端（连**只看**会话都）能单方面调画质/编码，原来只有 `log::info`，
    /// 被控者看到画面突然变糊/变清却不知原因。与 `emit_scope_changed` 同一
    /// 纪律：只有入站路径（`handle_inbound_input`）该调，本机自己改的不通知。
    pub(crate) fn emit_stream_note(&self, kind: &str, name: &str) {
        self.notify.emit_stream_note(kind, name);
    }

    pub(super) fn set_inject_err(&self, msg: String) {
        self.notify.set_inject_err(msg);
    }

    pub fn take_inject_err(&self) -> Option<String> {
        self.notify.take_inject_err()
    }

    /// 发起端取最近一帧（JPEG bytes）。无画面返 None。
    pub fn latest_frame(&self) -> Option<super::video::VideoFrame> {
        self.last_frame
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(super) fn set_frame(&self, f: super::video::VideoFrame) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    pub(super) fn clear_frame(&self) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 发起端：一帧入队（收流循环调用），并唤醒前端来取。
    pub(super) fn push_outbox(&self, f: super::video::VideoFrame) {
        {
            let mut g = self.frame_outbox.lock().unwrap_or_else(|p| p.into_inner());
            g.push(f);
        }
        self.notify.emit_frame_ready(now_ms());
    }

    /// 前端批量取走全部待显示帧（`rc_drain_frames` 命令）。取走即清。
    pub fn drain_frames(&self) -> Vec<super::video::VideoFrame> {
        self.frame_outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain()
    }

    pub(super) fn clear_outbox(&self) {
        self.frame_outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    pub(super) fn session_is(&self, phase: SessionPhase, peer: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.phase == phase && s.peer == peer)
    }

    pub(super) fn session_capability(&self) -> Option<Capability> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().map(|s| s.capability)
    }

    /// 发起端发送输入/剪贴板/流控帧。会话必须 OutboundActive。
    ///
    /// 免 Control 白名单（2026-09-20 二次审查拍板）：
    /// - **Ping / NetHint / SetBitratePct / SetQuality / SetCodec / RequestKey**：
    ///   只看会话的流控与自愈——否则 View 发不出心跳会误暂停推流。
    /// - **AudioOn**：只看可收系统声音（收声不改主机环境）。
    /// - **SetCaptureScope 要求 Control**：改采集范围会切到对方其它屏，属于
    ///   改主机可观测内容，只看不得改（与 SetHostMute 同级）。
    pub async fn send_input(&self, ev: &super::input::InputEvent) -> Result<(), String> {
        use super::input::InputEvent;
        let needs_control = !matches!(
            ev,
            InputEvent::Ping { .. }
                | InputEvent::NetHint { .. }
                | InputEvent::SetBitratePct { .. }
                | InputEvent::SetQuality { .. }
                | InputEvent::SetCodec { .. }
                | InputEvent::AudioOn { .. }
                | InputEvent::RequestKey
        );
        if needs_control {
            let cap = self.session_capability().ok_or("没有进行中的会话")?;
            super::input::assert_control_allowed(cap)?;
        }
        {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let s = inner.session.as_ref().ok_or("没有进行中的会话")?;
            if s.phase != SessionPhase::OutboundActive {
                return Err("会话尚未建立".into());
            }
        }
        // P0-3：鼠标移动走 QUIC 数据报——不可靠但免队头阻塞，视频大帧堵住
        // 可靠流时鼠标照样每拍都到。绝对坐标 latest-wins：丢一帧被下一帧校正。
        // 数据报不支持/发送失败 → 回退可靠流（原路）。
        if matches!(ev, super::input::InputEvent::MouseMove { .. }) {
            let json = serde_json::to_vec(ev).map_err(|e| e.to_string())?;
            let conn = self.outbound_conn.lock().await.clone();
            if let Some(conn) = conn {
                if conn.datagram_send_buffer_space() >= json.len()
                    && conn.send_datagram(json.into()).is_ok()
                {
                    return Ok(());
                }
            }
        }
        let mut guard = self.outbound_send.lock().await;
        let Some(send) = guard.as_mut() else {
            return Err("发送通道不可用".into());
        };
        let json = serde_json::to_vec(ev).map_err(|e| e.to_string())?;
        crate::sync::transport::write_frame(send, &json).await
    }

    /// 发起端会话链路统一收口：发送半流 + 连接句柄一起清。
    /// 🔴 连接句柄不清，下一场会话的鼠标数据报会发进旧连接（黑洞）。
    pub(super) async fn clear_outbound_link(&self) {
        *self.outbound_send.lock().await = None;
        *self.outbound_conn.lock().await = None;
        self.remote_loss_permille
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.peer_fps120
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.peer_refresh_hz
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.peer_hevc
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.peer_dgram_input
            .store(false, std::sync::atomic::Ordering::Relaxed);
        // Q7：对端屏列表是上一场会话的残留——不清的话，断连后 UI 还能
        // 「切到」一个早已不在场的显示器。
        self.peer_monitors
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// 发起端：把本地剪贴板文本推给被控端（R3 文本优先）。
    /// 按 **JSON 帧字节**卡上限，避免中文字符数过了但 write_frame 超 64KB。
    pub async fn push_clipboard(&self, text: &str) -> Result<(), String> {
        let ev = super::input::InputEvent::ClipboardPush {
            text: text.to_string(),
        };
        let json = serde_json::to_vec(&ev).map_err(|e| e.to_string())?;
        if json.len() > CLIPBOARD_MAX_JSON_BYTES {
            return Err(format!(
                "剪贴板过大（约 {} KB，上限约 {} KB），请改用文件或其他方式传输",
                json.len() / 1024,
                CLIPBOARD_MAX_JSON_BYTES / 1024
            ));
        }
        self.send_input(&ev).await
    }

    /// 发起端请求拉回对方剪贴板，并等回包（修「立刻 take 必空」竞态）。
    /// 超时或对方无回包时返回 `Ok(None)`。
    ///
    /// C8(b) 的两处串扰防线（并发 pull 共用一个序号 / 上个会话迟到的回包）
    /// 全部收在 `clipboard.rs` 里：这里只负责编排顺序 —— **先**拿串行化守卫、
    /// **再**取起点值、**然后**才发请求。顺序反了会漏掉请求发出后立刻到的回包。
    /// 判决策与取内容都走 `ClipboardState`，别再在这里直接读序号。
    pub async fn pull_clipboard(&self) -> Result<Option<String>, String> {
        let _serial = self.clip.lock_pull().await;
        let (epoch, before) = self.clip.snapshot();
        self.send_input(&super::input::InputEvent::ClipboardPull)
            .await?;
        let deadline = now_ms() + CLIPBOARD_PULL_TIMEOUT_MS;
        while now_ms() < deadline {
            match self.clip.decision(epoch, before) {
                ClipWait::Take => {
                    // P2-5：先看是不是失败回包——失败转 Err 报给用户，
                    // 绝不折叠成空串（空串与「对方剪贴板是空的」不可区分）。
                    if let Some(e) = self.clip.take_pull_error() {
                        return Err(e);
                    }
                    return Ok(self.clip.take());
                }
                ClipWait::Abandon => return Ok(None),
                ClipWait::KeepWaiting => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
        Ok(None)
    }

    /// 接收循环：对端回了 `clip_err`（P2-5）。记失败原因并唤醒等待循环，
    /// 让 `pull_clipboard` 以 Err 收场。
    pub(super) fn clip_pull_failed(&self, e: String) {
        self.clip.set_pull_error(e);
    }

    /// 会话收口时调用：作废仍在等待的 pull，并丢掉可能由迟到回包写入的文本。
    pub(super) fn invalidate_clipboard(&self) {
        self.clip.invalidate();
    }

    pub(super) fn set_remote_clipboard(&self, t: String) {
        self.clip.set_from_peer(t);
    }

    pub fn joins(&self) -> Arc<RcJoins> {
        self.joins.clone()
    }

    pub(super) fn cfg(&self) -> serde_json::Value {
        self.store.get_config().unwrap_or_default()
    }

    pub fn enabled(&self) -> bool {
        self.cfg()
            .get(CFG_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    pub fn max_capability(&self) -> Capability {
        self.cfg()
            .get(CFG_CAPABILITY)
            .and_then(|v| v.as_str())
            .and_then(Capability::parse)
            .unwrap_or(Capability::View)
    }

    pub fn device_deny(&self) -> HashMap<String, bool> {
        self.cfg()
            .get(CFG_DEVICE_DENY)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }

    /// 是否在**远程**配对表里。
    /// 是否在**远程**配对表里（只认 `rc_devices`，不含笔记同步表）。
    /// B-b：文件通道 / 免确认 / 自动收文件的准入判据。
    pub(super) fn is_rc_paired(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(_)))
    }

    /// 远程信任：远程配对 **或** 同步配对（方案 A 单向继承）。
    ///
    /// 🔴 B-b（2026-09-20 拍板）：这条只用于「能不能敲门 / 列表可见」；
    ///    **文件通道与免确认/自动接收只认 `rc_devices`**（`is_rc_paired`）。
    ///    同步配对设备首次要通过会话批准 elevate 写入 rc 表后，才获得文件准入。
    pub fn has_remote_trust(&self, node_id: &str) -> bool {
        if self.is_rc_paired(node_id) {
            return true;
        }
        matches!(self.store.device_get(node_id), Ok(Some(_)))
    }

    /// 同步设备首次被**人工批准**远程会话时写入 rc_devices（幂等）。
    ///
    /// B-b：同意一次会话 = 用户确认「这台同步设备可以远程我」，此后它就是
    /// 正式远程设备（可开免确认 / 自动收文件）。不在敲门时自动 elevate。
    pub fn elevate_from_sync(&self, node_id: &str) -> Result<(), String> {
        if self.is_rc_paired(node_id) {
            return Ok(());
        }
        let name = self
            .store
            .device_get(node_id)
            .ok()
            .flatten()
            .map(|d| d.name)
            .unwrap_or_else(|| "同步设备".into());
        self.store.rc_device_pair(node_id, &name)
    }

    /// 方案 D：这台设备是否开了「免确认直连」。
    ///
    /// 只认 rc 配对表——仅同步配对、还没被远程用过的设备没有行可查，
    /// 视为未开启（合理：免确认的前提是这台设备已经用过至少一次远程）。
    pub fn device_trusted(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(d)) if d.trusted)
    }

    /// 决策 10：这台设备是否开了「自动接收文件」。
    ///
    /// 与 `device_trusted` 同一口径：只认 rc 配对表，仅同步配对、还没被远程用过
    /// 的设备没有行可查 → 视为未开启（合理：自动接收的前提是它已经用过至少一次）。
    pub fn device_auto_accept(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(d)) if d.auto_accept)
    }

    /// 方案 D：设置「免确认直连」。仅同步配对的设备先幂等提升进 rc 表再设。
    ///
    /// 🔴 必须先确认**已配对**（rc 表或 sync 表有行）：对未知 id 不能顺手
    ///    `elevate_from_sync` ——那会凭空造出一行 rc 配对（名字「同步设备」）、
    ///    `has_remote_trust` 立刻变 true，等于绕过 SAS 配对把陌生设备放进白名单。
    pub fn set_device_trust(&self, node_id: &str, trusted: bool) -> Result<(), String> {
        if !self.has_remote_trust(node_id) {
            return Err("该设备尚未与本机配对，无法设置免确认".into());
        }
        self.elevate_from_sync(node_id)?;
        self.store.rc_device_trust_set(node_id, trusted)
    }

    /// 决策 10：设置「自动接收此设备推送的文件」。
    ///
    /// 前置条件与 `set_device_trust` 完全一致（要先是本机认可的设备），
    /// 少任何一个都会让开关在界面上点得动、却写不进去。
    ///
    /// 🔴 它只影响**要不要弹确认条**，不影响门禁：`gate_inbound` 一律先跑。
    /// 🔴 只对推送方向生效（对方发给我）。
    pub fn set_device_auto_accept(&self, node_id: &str, on: bool) -> Result<(), String> {
        if !self.has_remote_trust(node_id) {
            return Err("该设备尚未与本机配对，无法设置自动接收".into());
        }
        self.elevate_from_sync(node_id)?;
        self.store.rc_device_auto_accept_set(node_id, on)
    }

    pub(super) fn peer_name(&self, node_id: &str) -> String {
        if let Ok(Some(d)) = self.store.rc_device_get(node_id) {
            return d.name;
        }
        if let Ok(Some(d)) = self.store.device_get(node_id) {
            return d.name;
        }
        String::new()
    }

    pub fn status(&self) -> RcStatus {
        // C：路径自动切换（relay ↔ 直连）主动通知一次。
        // 放在取 `inner` 锁之前：通知会跑前端回调，不该在持锁期间做。
        // `take_path_change` 自带去重，多处 useRc 并发轮询时只会被消费一次。
        if let Some((from, to)) = self.link.take_path_change() {
            self.notify.emit_path_changed(from.as_str(), to.as_str());
        }
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let running = self
            .running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        let quality = self
            .cfg()
            .get(CFG_QUALITY)
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        // 自动档的「真实档位」只有**正在推流**时才存在：换档发生在推流循环里，
        // 会话没跑（或已结束）时 `tier` 只是上一场的残留。所以除了 auto_enabled，
        // 还必须要求本机正处在 inbound_active（本机推流）——否则界面会报一个
        // 早就不存在的档位，比不报还坏。
        let streaming = inner
            .session
            .as_ref()
            .is_some_and(|s| s.phase == SessionPhase::InboundActive);
        let active_quality = if streaming && self.auto_enabled() {
            self.auto_tier_name()
        } else {
            quality.clone()
        };
        RcStatus {
            enabled: self.enabled(),
            capability: self.max_capability().as_str().to_string(),
            session: inner.session.clone(),
            pending: inner.pending.clone(),
            joins: self.joins.list(now_ms()),
            uno: self.uno.active(now_ms()),
            uno_pass: unop::cfg_from(&self.cfg()).map(Into::into),
            device_deny: self.device_deny(),
            running,
            quality,
            active_quality,
            capture_scope: self
                .cfg()
                .get(CFG_CAPTURE_SCOPE)
                .and_then(|v| v.as_str())
                .unwrap_or("virtual")
                .to_string(),
            bitrate_pct: self.user_bitrate_pct_from_cfg(),
            rtt_ms: self.last_rtt_ms(),
            loss_permille: self
                .remote_loss_permille
                .load(std::sync::atomic::Ordering::Relaxed),
            path_kind: self.link.path_kind_str(),
            clock_skew_ms: self.clock_skew_ms(),
            peer_fps120: self.peer_fps120(),
            peer_hevc: self.peer_hevc(),
            peer_dgram_input: self.peer_dgram_input(),
            peer_refresh_hz: self.peer_refresh_hz(),
            peer_monitors: self
                .peer_monitors
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            last_pong_ms: self.link.last_pong_ms(),
            // clone 而非 take：Overlay/对话框/设置多处 useRc 并发轮询，take 会只有一处看见
            outbound_error: self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            reconnecting: self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(
                |s| RcReconnectInfo {
                    peer: s.peer.clone(),
                    peer_name: s.peer_name.clone(),
                    capability: s.capability.as_str().to_string(),
                    attempt: s.attempt,
                    max: s.max,
                    gave_up: s.gave_up,
                },
            ),
            // G3：本机静音。字段本身不带 cfg（与 peer_hevc 同例，跨平台可编译），
            // 非 Windows 上没有音频链路，恒 false。
            audio_local_mute: {
                #[cfg(target_os = "windows")]
                {
                    self.audio_local_mute()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    false
                }
            },
            // G3-B/C：**对端**报来的主机音频状态（发起端才有；被控端侧恒 None）。
            // `None` = 旧对端不发这条帧 → 前端不摆「对方已静音」那类断言。
            peer_audio: {
                #[cfg(target_os = "windows")]
                {
                    self.peer_host_audio()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    None
                }
            },
            // G3-C：被控端视角——对端静音了本机扬声器（提示 + 恢复入口）。
            spk_muted_by_peer: self.spk_muted_by_peer(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// 正在开会话的对端 node_id（无会话时 `None`）。在线判定用。
    pub fn active_session_peer(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().map(|s| s.peer.clone())
    }

    /// 是否需要通道：允许被控 **或** 已有远程配对（要发起）。
    /// 两者语义不同：`rc_enabled` 只管「别人能不能控你」；发起只要配对过。
    pub fn needs_channel(&self) -> bool {
        if self.enabled() {
            return true;
        }
        if matches!(self.store.rc_device_list(), Ok(list) if !list.is_empty()) {
            return true;
        }
        // 方案 A：仅同步配对的设备也可直接发起远程（同一 iroh 身份/端点），必须让通道起来，
        // 否则用户看得见设备（source="sync"）却发不起（B9）。
        matches!(self.store.device_list(), Ok(list) if !list.is_empty())
    }

    /// 启动独立通道。幂等。
    ///
    /// 🔴 **不再要求 `rc_enabled`**（方案 A）：发起远程的人往往从未打开过
    /// 「允许被远程」——那开关只应挡住**别人控你**，不该挡住你去控别人。
    /// 入站仍由 `gate_inbound` 看 `rc_enabled` 拒掉。
    pub async fn start(&self, app_dir: &Path, relay: bool) -> Result<(), String> {
        {
            let guard = self.running.lock().unwrap_or_else(|p| p.into_inner());
            if guard.is_some() {
                return Ok(());
            }
        }
        let me = Arc::new(NodeIdentity::load_or_create(app_dir)?);
        let endpoint = bind_rc_endpoint(&me, relay).await?;
        let port = endpoint
            .bound_sockets()
            .first()
            .map(|s| s.port())
            .ok_or("远程端点没有绑到任何端口")?;
        // 表与 `spawn` 用同一个 `PresenceApp::Rc`：表按它判串台、广播按它打标识，
        // 两处不一致会变成「自己拒自己」（收不到任何 RC 地址公告）。
        let presence = Arc::new(PresenceTable::new(PresenceApp::Rc));
        let stop = Arc::new(AtomicBool::new(false));
        let presence_running = Arc::new(AtomicBool::new(false));

        {
            let mut g = self.running.lock().unwrap_or_else(|p| p.into_inner());
            // C-7：双开竞态——两次 start 都看到 None 时，后到者不得覆盖先写入的
            // Running（会泄漏端点与 accept 循环）。写槽前再判一次。
            if g.is_some() {
                log::info!("[RC] start 并发：另一请求已完成绑定，本次丢弃");
                return Ok(());
            }
            *g = Some(Running {
                endpoint: endpoint.clone(),
                presence: presence.clone(),
                stop: stop.clone(),
                presence_running: presence_running.clone(),
                identity: me.clone(),
            });
        }

        let known = self.store.rc_device_list()?;
        log::info!(
            "[RC] 远程通道已启动，端口 {}，远程已配对 {} 台（允许被控={})",
            port,
            known.len(),
            self.enabled()
        );

        // accept 循环
        {
            let svc = global().ok_or("RcService 未安装到 global")?;
            let ep = endpoint.clone();
            let stop2 = stop.clone();
            tauri::async_runtime::spawn(async move {
                accept_loop(svc, ep, stop2).await;
            });
        }

        // 本机设备名**只取一次**：`spawn`（招呼包随包自报）与 `arm`（配对握手包
        // 自报）用的是同一份。两处各调一次 `hostname::get()` 就是两个数据源。
        let my_name = super::local_device_name();

        // presence：宣告 RC 端口；is_paired 用**远程信任**（rc ∪ 同步），
        // 否则仅同步配对的对端收不到本机 RC 地址，局域网发现会失败。
        {
            let store_online = self.store.clone();
            // 明文包（附近招呼 + 配对握手）交给 `discovery`。
            // ❗ 不注册的话它们只会留一条 debug（`spawn` 里有兜底日志），
            //   表现是「附近设备永远是空的」，且从界面上完全看不出为什么。
            let disc = self.discovery.clone();
            presence.on_plain(Arc::new(move |p: &presence::PlainPacket| {
                disc.handle_plain(p);
            }));
            presence::spawn(presence::PresenceStart {
                enabled: true,
                app: PresenceApp::Rc,
                table: presence,
                me: me.clone(),
                endpoint_port: port,
                is_paired: rc_paired_fn(&self.store),
                // 听见对端「回来」→ 刷 rc_devices 在线（修纯 RC 配对永远 offline）
                on_fresh: Arc::new(move |id: &str| {
                    let _ = store_online.rc_device_touch(id, true);
                }),
                running: presence_running,
                port: RC_PRESENCE_PORT,
                // 「附近的设备」全靠这一条：周期发招呼包，把名字自报给同网段
                // **还没配对**的邻居。少了它，那块列表永远是空的
                // （2026-09-17 首版就是这样——收包侧写好了，发的那侧没接上）。
                hello_name: Some(my_name.clone()),
            });
        }

        // 挂上「怎么发」：局域网配对的握手包发往 rc 那套 presence 的端口。
        // 必须在 presence 起来之后做——`arm` 之前发的包会被 `send` 拒掉。
        self.discovery.arm(me, port, RC_PRESENCE_PORT, my_name);

        Ok(())
    }

    /// 局域网配对：附近的设备（未配对的邻居）。
    ///
    /// ❗ 已配对的不在列表里（判据与 presence 收包侧**同一个** `rc_paired_fn`）——
    /// 否则设备列表与附近列表会同时显示同一台机器，用户分不清该点哪个。
    pub fn nearby_neighbors(&self, now_ms: i64) -> Vec<crate::sync::presence::Neighbor> {
        self.discovery.neighbors(now_ms)
    }

    /// 局域网配对：当前那一轮（没有就是 `None`）。
    ///
    /// ❗ 顺带重传该重传的包（`discovery.tick`）：**界面开着的时候**才有必要重传，
    /// 而没有界面在读状态时也就不该有配对的包在路上（用户已经走开了）。
    pub fn nearby_prompt(&self, now_ms: i64) -> Option<super::pin::PairPrompt> {
        let p = self.discovery.prompt(now_ms);
        if p.is_some() {
            self.discovery.tick(now_ms);
        }
        p
    }

    /// 局域网配对：刚成功的那一台（读完即清）。
    pub fn nearby_take_done(&self) -> Option<super::pin::Done> {
        self.discovery.take_done()
    }

    pub fn nearby_pair_start(
        &self,
        peer_id: &str,
        now_ms: i64,
    ) -> Result<super::pin::PairPrompt, String> {
        let r = self.discovery.pair_start(peer_id, now_ms);
        if r.is_ok() {
            self.emit_pair_changed();
        }
        r
    }

    pub fn nearby_confirm(&self, now_ms: i64) -> Result<super::pin::Confirmed, String> {
        let r = self.discovery.confirm(now_ms);
        self.emit_pair_changed();
        r
    }

    pub fn nearby_cancel(&self, now_ms: i64) -> bool {
        let ok = self.discovery.cancel(now_ms);
        if ok {
            self.emit_pair_changed();
        }
        ok
    }

    /// 局域网配对状态变了 → 通知前端。
    ///
    /// 与 `notify.emit_changed` 是同一件事（同一个 `rc-session-changed` 事件），
    /// 收成一个方法是为了不让 `discovery.rs` 直接碰 `notify` 这个内部字段。
    pub fn emit_pair_changed(&self) {
        self.notify.emit_changed();
    }

    /// presence 里当前还听得见的对端（局域网在线）。
    pub fn presence_live_ids(&self) -> Vec<String> {
        let g = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let Some(r) = g.as_ref() else {
            return Vec::new();
        };
        r.presence.live(now_ms())
    }

    pub async fn stop(&self) {
        // 先收口会话（发 End / 清帧），再关通道，避免留下「可控」假状态
        {
            let has = {
                let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.session.is_some()
            };
            if has {
                let _ = self.end_session("远程通道关闭").await;
            }
        }
        let running = {
            let mut g = self.running.lock().unwrap_or_else(|p| p.into_inner());
            g.take()
        };
        if let Some(r) = running {
            r.stop.store(true, Ordering::SeqCst);
            r.presence_running.store(false, Ordering::SeqCst);
            r.endpoint.close().await;
            // 局域网配对：摘掉「怎么发」并清掉会话与附近表。
            // ❗ **不清 `rc_devices`** —— 那是落库的配对结果，与通道起停无关。
            //   清掉的话用户会发现「重启一次配对全没了」。
            self.discovery.disarm();
            self.joins.clear();
            {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.session = None;
                inner.pending.clear();
            }
            *self.outbound_send.lock().await = None;
            *self.outbound_conn.lock().await = None;
            *self.inbound_send.lock().await = None;
            // Q2/Q6：通道停了，接入码全部作废（它们只活在内存里），
            // 自动重连 episode 也失去意义——继续重试只会拿到 [channel_down]，
            // 三次用尽再给用户挂一条「自动重连失败」横幅纯属误导。
            let revoked = self.uno.revoke_all();
            if revoked > 0 {
                log::info!("[RC] 通道停止，已作废 {revoked} 个无人值守接入码");
            }
            *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
            log::info!("[RC] 远程通道已停止");
        }
    }

    pub fn pending_joins(&self) -> Vec<join::RcJoinRequest> {
        self.joins.list(now_ms())
    }

    pub fn approve_join(&self, node_id: &str, name: &str) -> Result<(), String> {
        if !self.joins.take(node_id) && !self.is_rc_paired(node_id) {
            // 已配对再点一次也允许（幂等刷新名字）
            if !self.is_rc_paired(node_id) {
                return Err("没有待确认的远程配对请求".into());
            }
        }
        let n = if name.trim().is_empty() {
            "新设备".to_string()
        } else {
            name.trim().to_string()
        };
        self.store.rc_device_pair(node_id, &n)?;
        // 🔴 **配对成功即关门**（2026-09-17 补，`sync::join` 早就是这个做法）。
        //   码里带的是「node_id + 名字」、**不是一次性 nonce** ⇒ 同一份码在窗口内
        //   可以被反复使用。「配完就关门」比「把窗口调短」更管用，也更符合直觉：
        //   一次配对只该消耗一份邀请。
        //   关门失败不阻断配对本身——设备已经写进白名单了，报错会让用户以为
        //   白配一场；但也不能静默（规则 #15.3）。
        if let Err(e) = join::close_door(&self.store) {
            log::warn!("[RC] 配对成功后关闭邀请窗口失败：{e}——这份码在本轮窗口内仍可使用");
        }
        Ok(())
    }

    pub fn deny_join(&self, node_id: &str) {
        self.joins.deny(node_id, now_ms());
    }

    /// 拿「已启动的端点 + presence 表」。`pub(super)` 是因为文件通道（G6）
    /// 要自己拨号——它独立于 RC 会话，不复用会话的连接。
    pub(super) fn transport_ready(&self) -> Option<(Endpoint, Arc<PresenceTable>)> {
        let g = self.running.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().map(|r| (r.endpoint.clone(), r.presence.clone()))
    }

    /// 非阻塞发起远程：立刻落 OutboundPending 并返回，dial 在后台跑。
    /// 前端可立即展示等待 UI 并取消；结果经 `rc-session-changed` / `outbound_error` 回传。
    pub async fn request_session(
        &self,
        peer: &str,
        capability: Capability,
        uno_code: Option<String>,
        uno_pass: Option<String>,
    ) -> Result<Session, String> {
        // 无人值守（Q2 方案 B 码 / 方案 C 密码）：带凭证发起就是「未配对机器」
        // 的路径，白名单前置检查必须让位；空串视同没带。
        let uno_code = uno_code
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let uno_pass = uno_pass
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let with_cred = uno_code.is_some() || uno_pass.is_some();
        let (session_id, pending_sess) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if gate_outbound(inner.session.is_some()) == Gate::Busy {
                return Err("[busy_local] 已有进行中的远程会话，请先结束".into());
            }
            if !with_cred && !self.has_remote_trust(peer) {
                return Err(
                    "[not_paired] 尚未完成远程配对：请先在远程电脑设置里配对这台设备".into(),
                );
            }
            if !self.is_running() {
                return Err("[channel_down] 远程通道未启动：请先开启远程通道或完成远程配对".into());
            }
            // 同步设备首次发起远程 → 写入 rc_devices（方案 A）
            if !with_cred {
                if let Err(e) = self.elevate_from_sync(peer) {
                    log::warn!("[RC] 从同步配对提升到远程失败：{e}");
                }
            }
            let id = new_session_id(now_ms());
            let sess = Session {
                id: id.clone(),
                peer: peer.to_string(),
                peer_name: self.peer_name(peer),
                capability,
                phase: SessionPhase::OutboundPending,
                started_ms: now_ms(),
                granted: false,
            };
            inner.session = Some(sess.clone());
            (id, sess)
        };
        {
            let mut g = self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *g = None;
        }
        // 立刻让前端看到 Pending，取消按钮才能点
        self.emit_changed();

        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            let Some(svc) = global() else { return };
            match svc
                .dial_and_request(&peer, capability, uno_code.clone(), uno_pass.clone())
                .await
            {
                Ok((accepted_cap, conn, send, recv)) => {
                    // 会话是否已经不在（用户点了取消，或已被换成了另一场会话）。
                    // ❗ 这里**不能**在持 inner 锁的块里 return 并顺手 detach：
                    //    `link.detach()` 与 `status()` 的加锁顺序相反，会构成 ABBA 死锁。
                    let cancelled = {
                        let mut inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
                        match inner.session.as_mut() {
                            Some(sess) if sess.id == session_id => {
                                sess.phase = SessionPhase::OutboundActive;
                                sess.capability = accepted_cap;
                                sess.granted = true;
                                false
                            }
                            _ => true,
                        }
                    };
                    if cancelled {
                        // 用户已取消：先把链路句柄收掉，再关掉刚建好的流。
                        // 交回的路径/网速在这里没有意义（会话根本没成立），显式丢弃。
                        let _ = svc.link.detach();
                        drop(send);
                        drop(recv);
                        // conn 同旧版为等价处理：没人再持有它（连接悬着由会话收口兜底），
                        // 没有显式 close 是刻意的——close 理由会进对端日志，别在「本端取消」
                        // 这条路径上给对端制造一条需要解释的关闭帧。
                        drop(conn);
                        return;
                    }
                    // B-b：会话在对端获批 = 首次远程信任确认。发起侧同步写入
                    // rc_devices（对端 approve 时也会 elevate 它自己那份），
                    // 之后双向文件通道与免确认才都有行可查。
                    if let Err(e) = svc.elevate_from_sync(&peer) {
                        log::warn!("[RC] 发起侧 elevate 失败：{e}");
                    }
                    let _ = svc.store.rc_device_touch(&peer, true);
                    // Q2：无人值守接入成功（码或密码）= 发起侧也把这台写进自己的
                    // rc_devices（被控侧在验凭证时已经写了它那份）。之后这台设备
                    // 就是普通配对设备：改名 / 免确认 / 遗忘都走既有管理面。
                    if with_cred {
                        let name = {
                            let n = svc.peer_name(&peer);
                            if n.is_empty() { "新设备".to_string() } else { n }
                        };
                        if let Err(e) = svc.store.rc_device_pair(&peer, &name) {
                            log::warn!("[RC] 接入码连入成功，但发起侧写设备列表失败：{e}");
                        }
                    }
                    svc.clear_frame();
                    svc.clear_outbox();
                    #[cfg(target_os = "windows")]
                    svc.audio_reset();
                    svc.note_rtt(0);
                    // 🔴 取消竞态收口（2026-09-20 审计 P2-3）：从 cancelled 判定到
                    // 写槽之间隔着 store 写盘等 await 点，用户恰好取消时——
                    // end_session 写 End 时槽位还是 None（对端收不到 End），
                    // 随后句柄仍被写回成僵尸。写槽前再查一次会话 id；
                    // 仍存在的残余窗口（查完到写完之间收口）不足 1ms，
                    // 且僵尸句柄会被下一场会话的写槽覆盖、end_session 也会清。
                    if svc.session_id_is(&session_id) {
                        *svc.outbound_send.lock().await = Some(send);
                        *svc.outbound_conn.lock().await = Some(conn.clone());
                        svc.spawn_outbound_video(&peer, recv, conn);
                    } else {
                        log::info!("[RC] 会话在建立途中已被取消，丢弃刚建好的流句柄");
                        drop(send);
                        drop(recv);
                        drop(conn);
                    }
                    svc.emit_changed();
                }
                Err(e) => {
                    {
                        let mut inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(s) = inner.session.as_ref() {
                            if s.id == session_id {
                                inner.session = None;
                            }
                        }
                    }
                    // `dial_and_request` 在连接通了之后就已经 attach（那时才可能走到
                    // Request 被拒），会话没建成 → 必须清掉，否则路径标签挂在死连接上。
                    // 交回的路径同样丢弃：一次失败的发起不该被记成「上次走的哪条路」。
                    let _ = svc.link.detach();
                    {
                        let mut g = svc
                            .last_outbound_error
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        *g = Some(e);
                    }
                    svc.emit_changed();
                }
            }
        });

        Ok(pending_sess)
    }

    pub fn clear_outbound_error(&self) {
        let mut g = self
            .last_outbound_error
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *g = None;
    }

    /// 发起端：收 JPEG / 脏矩形 / 控制帧（实现在 `rc/outbound.rs`）。
    ///
    /// 🔴 **不再合成再编码**：整帧与脏块 JPEG 原样交给前端画布合成，
    /// 避免「网络传脏矩形、本机却整帧 clone + 二次 JPEG」的白做功。
    fn spawn_outbound_video(
        &self,
        peer: &str,
        recv: iroh::endpoint::RecvStream,
        conn: iroh::endpoint::Connection,
    ) {
        let Some(svc) = global() else { return };
        let Some(video) = super::outbound::OutboundVideo::try_new(svc, peer, recv, conn) else {
            log::warn!("[RC] 发起端画面流启动前会话已结束，放弃推流");
            return;
        };
        tauri::async_runtime::spawn(video.run());
    }

    /// 轻量探活：拨通即认为可达，立刻断开（不建会话、不发 Request）。
    ///
    /// # 🔴 2026-09-21：本方法**不再写任何库状态**
    ///
    /// 旧实现拨通后 `rc_device_touch(peer, true)`——这是「在线状态不准」的主因之一：
    /// - 探测结果是**「这一刻可达」的瞬时事实**，不是「在线」这个持久状态；
    /// - 它写的 `last_seen` 语义是「最后一次**在线**是什么时候」，
    ///   被探测刷新后，「上次在线：3 小时前」会变成「刚刚」，污染历史语义；
    /// - 用户点一下刷新 → 所有能拨通的设备集体续命 → 表现为「点一下就变在线」。
    ///
    /// 现在的结果**只回传给调用方**（`probe_peers` 的 `HashMap` → IPC → 前端），
    /// 由前端渲染成「本次探测可达」的**独立标记**，与在线状态分开显示。
    ///
    /// ❗ 别在这里"顺手"把 touch 加回来。在线状态的真源是三条证据
    /// （见 `session::is_rc_online_for`），不是探测结果。
    pub async fn probe_peer(&self, peer: &str) -> Result<(), String> {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer).map_err(|e| format!("node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }
        let conn = tokio::time::timeout(std::time::Duration::from_secs(3), ep.connect(addr, ALPN))
            .await
            .map_err(|_| "探测超时".to_string())?
            .map_err(|e| format!("连不上：{}", e))?;
        // 探通立刻收：不占对端 accept 槽，也不进入 Request 流程
        conn.close(0u32.into(), b"probe");
        // ❗ 到这里**故意什么库都不写**：探测是瞬时事实，不是在线状态。
        //    写 last_seen 会污染「上次在线」语义并制造假在线（见上面 doc）。
        Ok(())
    }

    /// 批量探活：并发短超时拨，结果 node_id → 是否可达。
    /// 上限 8 台并行——自有设备列表远小于此；再大也是用户自己配的，超时仍 3s/台。
    pub async fn probe_peers(&self, peers: &[String]) -> std::collections::HashMap<String, bool> {
        use std::collections::HashMap;
        let mut out = HashMap::new();
        if peers.is_empty() {
            return out;
        }
        let chunk = 8usize;
        for batch in peers.chunks(chunk) {
            let mut futs = Vec::with_capacity(batch.len());
            for p in batch {
                let p = p.clone();
                // probe_peer 只借用 self；spawn 不了（要 'static），直接并发 future
                futs.push(async move { (p.clone(), self.probe_peer(&p).await.is_ok()) });
            }
            let results = futures_util::future::join_all(futs).await;
            for (id, ok) in results {
                out.insert(id, ok);
            }
        }
        out
    }

    async fn dial_and_request(
        &self,
        peer: &str,
        capability: Capability,
        uno_code: Option<String>,
        uno_pass: Option<String>,
    ) -> Result<
        (
            Capability,
            // 🔴 连接句柄必须交出去：发起端收流循环（`outbound.rs`）断流时要用
            //   `conn.close_reason()` 把「对端为什么关」拼回错误（见 `explain`）。
            //   原先它只在函数内活着，返回即 drop——收流侧只剩 `connection lost`。
            iroh::endpoint::Connection,
            iroh::endpoint::SendStream,
            iroh::endpoint::RecvStream,
        ),
        String,
    > {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("[channel_down] 远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer)
            .map_err(|e| format!("[bad_node_id] node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }

        // 🔴 拨号必须带超时（2026-09-20 审计 P2-4）：裸等在网络黑洞下会让
        // OutboundPending 挂死、占住 busy 闸，用户只能手动取消。15 秒对
        // 「绕中继 + 国内网络」是宽松上限（probe_peer 的 3 秒是给探测用的，
        // 正式拨号放一倍以上余量）。
        let conn = tokio::time::timeout(std::time::Duration::from_secs(15), ep.connect(addr, ALPN))
            .await
            .map_err(|_| "[connect_failed] 连接对端超时（15 秒）：对方可能不在线".to_string())?
            .map_err(|e| format!("[connect_failed] 连接对端失败：{}", e))?;
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("开流失败：{}", e))?;

        // 连接已通，先把句柄登记进去：会话进入 Active 之前界面就能报出路径档位
        // （「是不是绕中继」恰恰是用户连上之前最想知道的）。
        // 若随后 Request 被拒，调用方的错误分支会 `link.detach()` 清掉——
        // 那一处不能漏，漏了会残留一条僵尸连接的路径标签。
        self.link.attach(&conn);

        let req = RcFrame::Request {
            capability,
            uno_code,
            uno_pass,
            // 本端支持视频数据报；旧对端 serde 忽略未知字段，照常受理
            vid_dgram: Some(true),
            // G3：本端支持音频。会话中由 AudioOn 开关；被控端无渲染设备时自动无声
            audio: Some(true),
        };
        // ❗ 这一对读写的失败必须过 `explain`：对端要是以「未配对 / 忙 / 被禁」为由
        //   关掉连接，原始错误只会是 `读帧长度失败：connection lost`（见 `explain`）。
        crate::sync::transport::write_frame(&mut send, &req.encode()?)
            .await
            .map_err(|e| explain(&conn, e))?;
        let raw = crate::sync::transport::read_frame(&mut recv)
            .await
            .map_err(|e| explain(&conn, e))?;
        let resp = RcFrame::decode(&raw)?;
        match resp {
            RcFrame::Accept { capability } => Ok((capability, conn, send, recv)),
            RcFrame::Deny { reason, code } => {
                let code = code.unwrap_or_default();
                if code.is_empty() {
                    Err(reason)
                } else {
                    Err(format!("[{code}] {reason}"))
                }
            }
            other => Err(format!("对端回了意外的帧：{other:?}")),
        }
    }

    /// 入站连接（本模块 accept_loop 调用）。
    pub async fn handle_inbound_conn(&self, conn: iroh::endpoint::Connection) {
        use crate::sync::transport::{read_frame, write_frame};

        let peer = conn.remote_id().to_string();
        let short = peer[..8.min(peer.len())].to_string();
        let Ok(w) = crate::sync::transport::accept_streams(conn).await else {
            log::warn!("[RC] {short} 开流失败");
            return;
        };
        // 留一份连接 handle：批准之后要拿它读「对方是从哪条路进来的」（`link.rs`）。
        // 必须在解构之前 clone——`w.send` / `w.recv` 一旦移出就不能再碰 `w`。
        let link_conn = w.conn.clone();
        let mut send = w.send;
        let mut recv = w.recv;

        let Ok(bytes) = read_frame(&mut recv).await else {
            // 连接已断，写 Deny 也到不了——只能记日志，不能静默（规则 #15.3）
            log::warn!("[RC] {short} 读申请帧失败，连接已断");
            return;
        };
        // 对端把 Request 送到了 = 它在线。刷 last_seen，跨网时设备列表才亮得起来。
        let _ = self.store.rc_device_touch(&peer, true);
        let (requested, uno_code, uno_pass, peer_dgram, peer_audio) = match RcFrame::decode(&bytes) {
            Ok(RcFrame::Request {
                capability,
                uno_code,
                uno_pass,
                vid_dgram,
                audio,
            }) => (
                capability,
                uno_code,
                uno_pass,
                vid_dgram == Some(true),
                audio == Some(true),
            ),
            Ok(_) => {
                deny_and_close(&link_conn, &mut send, "期望 Request 帧", "not_request").await;
                return;
            }
            Err(e) => {
                log::warn!("[RC] {short} 帧解码失败：{e}");
                deny_and_close(&link_conn, &mut send, "对端协议帧无法识别", "bad_request").await;
                return;
            }
        };

        let mut uno_admitted = false;
        // 未配对（远程/同步都没有）：
        // 带了无人值守接入码（Q2 方案 B）→ 验码，通过 = 自动配对 + 自动同意；
        // 带了固定密码（Q2 方案 C）→ 验密 + 限速闸，通过 = 同上；
        // 都没带 → 走邀请门/敲门老路，等人核对指纹。
        if !self.has_remote_trust(&peer) {
            let now = now_ms();
            match (uno_code.as_deref(), uno_pass.as_deref()) {
                (Some(code), _) => match self.uno_admit(&peer, requested, code, now) {
                    UnoAdmit::Admitted => uno_admitted = true,
                    UnoAdmit::Denied(reason, deny_code) => {
                        deny_and_close(&link_conn, &mut send, &reason, &deny_code).await;
                        log::info!("[RC] {short} 无人值守接入被拒：{reason}");
                        return;
                    }
                },
                (None, Some(pass)) => {
                    // 局域网判定在这里做（函数要拿连接），准入逻辑收进纯函数可测的
                    // `pass_admit`（`rc/tests.rs` 直接打它）。
                    let is_lan =
                        crate::sync::path_kind::of_conn(&link_conn) == crate::sync::path_kind::PathKind::Lan;
                    match self.pass_admit(&peer, requested, pass, is_lan, now) {
                        UnoAdmit::Admitted => uno_admitted = true,
                        UnoAdmit::Denied(reason, deny_code) => {
                            deny_and_close(&link_conn, &mut send, &reason, &deny_code).await;
                            log::info!("[RC] {short} 固定密码接入被拒：{reason}");
                            return;
                        }
                    }
                }
                (None, None) => {
                    // 🔴 **判据交给纯函数**（[`join::deny_unpaired`]），因为「几种成因的区分」
                    //   正是 2026-09-17 修的那个 bug：原先除「门开着且敲门成功」外全部塌缩成一句
                    //   `not_paired`（「尚未远程配对」），而用户实际撞到的**几乎总是窗口过期**——
                    //   那句话指不到「回去重新生成一个」这个唯一正确的动作，
                    //   于是他只能反复重试同一个已经失效的窗口。
                    //   而 accept 循环（网络）在单测里跑不起来 ⇒ 判据必须抽出去才测得动。
                    //
                    //   文案由 `KnockDenial::reason()` 提供，**一律站在收到这句话的人的立场**
                    //   （他是发起方 B，对面是生成方 A），与 `Gate::deny_reason` 的既有约定一致。
                    //
                    // 红线「未启用 = 零可见零请求零费用」：rc_enabled 关闭时，即便邀请门开着，
                    // 也不记入 pending、不 emit，只回 deny（门禁在下方 gate_inbound 也会拦，
                    // 但这里先挡住，避免禁用期间出现可见的配对请求）。
                    match join::deny_unpaired(
                        self.enabled(),
                        join::door_open(&self.store, now),
                        self.joins.is_denied(&peer, now),
                    ) {
                        Some(d) => {
                            deny_and_close(&link_conn, &mut send, d.reason(), d.code()).await;
                            log::info!("[RC] {short} 敲门被拒：{}", d.log_label());
                        }
                        None => {
                            self.joins.knock(&peer, now);
                            deny_and_close(
                                &link_conn,
                                &mut send,
                                "等待对方确认配对",
                                "await_pair_confirm",
                            )
                            .await;
                            log::info!("[RC] {short} 敲门配对，已记入待确认");
                            self.emit_changed();
                        }
                    }
                    return;
                }
            }
        }

        if !uno_admitted {
            let gate = {
                let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                gate_inbound(
                    self.enabled(),
                    self.max_capability(),
                    &self.device_deny(),
                    &peer,
                    self.has_remote_trust(&peer),
                    requested,
                    inner.session.is_some(),
                )
            };
            if gate != Gate::Allow {
                deny_and_close(&link_conn, &mut send, gate.deny_reason(), gate.deny_code()).await;
                log::info!("[RC] 拒绝 {short}：{}", gate.deny_reason());
                return;
            }

            // 方案 D「免确认直连」：门禁全绿（含 deny 检查——DeviceDenied 根本到不了
            // Allow）且这台设备开了免确认 ⇒ 直接落会话。下面的等待循环 200ms 内
            // 看到 `InboundActive` 就回 Accept，对端体感是「连上就进」。
            // 自动接受失败（唯一现实成因是并发下本机已有会话）不静默，
            // 也不硬拒——落回人工确认，让人看见再说。
            let auto_accepted = if self.device_trusted(&peer) {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                match self
                    .establish_inbound_with(&mut inner, &peer, self.peer_name(&peer), requested)
                {
                    Ok(_) => {
                        log::info!("[RC] {short} 来自免确认设备，自动接受");
                        true
                    }
                    Err(e) => {
                        log::warn!("[RC] {short} 免确认自动接受失败（{e}），转入人工确认");
                        false
                    }
                }
            } else {
                false
            };

            if !auto_accepted {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                if !inner.pending.iter().any(|k| k.peer == peer) {
                    inner.pending.push(InboundKnock {
                        peer: peer.clone(),
                        peer_name: self.peer_name(&peer),
                        capability: requested,
                        first_seen_ms: now_ms(),
                    });
                }
            }
        }
        // 有申请进来立刻通知前端（窗口隐藏时也能 toast）
        self.emit_changed();

        let deadline = now_ms() + 120_000;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // 🔴 超时判定必须放在 decision **之后**（2026-09-20 审计 P1-2）：
            // 原先超时检查在读取会话之前，批准落在最后 <200ms 窗口时——
            // approve_inbound 已建会话、pending 已删，这里却先按超时把连接
            // deny_and_close 掉：会话槽是活跃态但推流任务永不执行，且这个
            // 僵尸会话没有任何看门者（TTL 检查只存在于视频循环里），
            // 横幅卡「被控中」直到手动结束。
            let decision = {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                // 先在不可变借用里判状态、出借后再写标记（推流所有权的
                // 判定与置位必须在同一把锁里完成，否则双循环都能抢到）。
                let verdict = match inner.session.as_ref() {
                    Some(s) if s.peer == peer && s.phase == SessionPhase::InboundActive => {
                        if inner.inbound_streaming {
                            Some(Err("already_streaming"))
                        } else {
                            Some(Ok(s.capability))
                        }
                    }
                    Some(s) if s.peer != peer => Some(Err("busy")),
                    Some(_) => None,
                    None => {
                        if !inner.pending.iter().any(|k| k.peer == peer) {
                            Some(Err("denied"))
                        } else {
                            None
                        }
                    }
                };
                // 抢到推流所有权：出借结束后置位（P2-1 双连接守卫）
                if matches!(verdict, Some(Ok(_))) {
                    inner.inbound_streaming = true;
                }
                verdict
            };
            match decision {
                Some(Ok(cap)) => {
                    if let Ok(b) = (RcFrame::Accept { capability: cap }).encode() {
                        let _ = write_frame(&mut send, &b).await;
                    }
                    // 用户批准、会话真的建立：登记连接，被控端也能看到「对方是从
                    // 局域网还是绕中继进来的」。此处不持有 inner 锁（上面那个
                    // decision 块已结束），与 `status()` 的加锁顺序一致。
                    self.link.attach(&link_conn);
                    // R1：推 JPEG 画面直到会话结束（conn 一并交给推流任务：
                    // 鼠标数据报读取 + stats 采样都挂在它身上）
                    spawn_inbound_video(&peer, send, recv, link_conn, peer_dgram, peer_audio).await;
                    return;
                }
                Some(Err("already_streaming")) => {
                    // 输掉推流所有权的重复连接：安静收掉即可，不算拒绝。
                    // 对端若在这条连接上等 Accept，收到的关闭理由是会话已被
                    // 另一条连接接管——它的真实会话仍然活着。
                    log::info!("[RC] {short} 重复连接：会话已由另一条连接接管，关闭本条");
                    let _ = send.finish();
                    link_conn.close(0u32.into(), b"session taken");
                    self.clear_pending(&peer);
                    return;
                }
                Some(Err(_)) => {
                    deny_and_close(
                        &link_conn,
                        &mut send,
                        "对方拒绝或会话被占用",
                        "rejected_or_busy",
                    )
                    .await;
                    self.clear_pending(&peer);
                    return;
                }
                None => {
                    // 只有「还在等」才允许超时（P1-2 修正：超时判定移到 decision 之后）
                    if now_ms() > deadline {
                        self.clear_pending(&peer);
                        deny_and_close(&link_conn, &mut send, "等待确认超时", "confirm_timeout")
                            .await;
                        return;
                    }
                    continue;
                }
            }
        }
    }

    fn clear_pending(&self, peer: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.pending.retain(|k| k.peer != peer);
    }

    /// 无人值守接入码准入（Q2 方案 B）。验码 → 落白名单 →（可选）开免确认 →
    /// 建会话 → 消费一次。任何一步不过都不碰待验表。
    ///
    /// 与免确认直连（方案 D）的差别在**信任的来源**：那边的信任是用户提前
    /// 逐台点过头（rc_devices.trusted），这里的信任是「此刻有人在场生成了
    /// 一个 15 分钟的码，并把码交到了对方手里」——所以验码通过后**必须落
    /// 白名单**（与现场配对同一张表），让这台设备从此受横幅/历史/禁止/免确认
    /// 的常规管理，而不是留在某个隐形的旁门里。
    ///
    /// # 🔴 消费时机的顺序不变量
    ///
    /// [`Self::uno`] 的 `verify` 只判不消费；`consume` 只在会话真的建立之后调。
    /// 反过来（验完就消费）的话，「码对、但本机正忙」会把一次有效的接入烧掉，
    /// 对端看到的是自相矛盾的「码没错但连不上」。
    fn uno_admit(&self, peer: &str, requested: Capability, code: &str, now_ms: i64) -> UnoAdmit {
        let short = &peer[..8.min(peer.len())];
        // 红线先行：未启用 = 一律拒，且**不**泄露「码对不对」（用同一句门禁话）。
        if !self.enabled() {
            return UnoAdmit::Denied(
                Gate::Disabled.deny_reason().to_string(),
                Gate::Disabled.deny_code().to_string(),
            );
        }
        let Some(grant) = self.uno.verify(code, now_ms) else {
            return UnoAdmit::Denied("接入码无效或已过期".into(), "uno_invalid".into());
        };
        // 逐台禁止优先于码：用户明确拉黑过的设备，一张新码不该替他翻案。
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return UnoAdmit::Denied(
                Gate::DeviceDenied.deny_reason().to_string(),
                Gate::DeviceDenied.deny_code().to_string(),
            );
        }
        // 落白名单。设备名此刻无从核对（对方自报名要等招呼包），先给可读的占位。
        let name = {
            let n = self.peer_name(peer);
            if n.is_empty() {
                "新设备".to_string()
            } else {
                n
            }
        };
        if let Err(e) = self.store.rc_device_pair(peer, &name) {
            // 存储错误原文只进日志；deny 话术回给一个**未通过认证**的连接，
            // 不该携带本机路径/IO 细节（2026-09-19 审查）。
            log::error!("[RC] {short} 接入码准入写设备列表失败：{e}");
            return UnoAdmit::Denied("对方暂时无法处理该接入码".into(), "uno_store_error".into());
        }
        // 申请档超过码授予的档 → 压到码的档（Accept 会把真实档回给对端，
        // 对端 UI 就按「只看」渲染，与既有提权流程一致）。
        let cap = if requested.allowed_by(grant.capability) {
            requested
        } else {
            grant.capability
        };
        let established = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            self.establish_inbound_with(&mut inner, peer, name, cap)
        };
        match established {
            Ok(_) => {
                // 🔴 免确认在**会话真的建立之后**才落库：若在 establish 之前写，
                // 「码有效但本机正忙」的失败会留下一个 trusted=true 的设备——
                // 码是一次性的，免确认却是永久的，等于把一次性码洗成常驻后门
                // （2026-09-19 审查发现的 P1）。白名单本身保留：对方确实持有
                // 有效码，落库后仍受逐台确认/禁止的常规管理。
                if grant.also_trust {
                    if let Err(e) = self.set_device_trust(peer, true) {
                        log::warn!("[RC] {short} 接入码连入后开免确认失败：{e}");
                    }
                }
                self.uno.consume(&grant.hash);
                log::info!(
                    "[RC] {short} 通过无人值守接入码连入（{}）",
                    cap.as_str()
                );
                UnoAdmit::Admitted
            }
            Err(e) => {
                log::warn!("[RC] {short} 接入码有效但建立会话失败：{e}");
                UnoAdmit::Denied(e, "busy".into())
            }
        }
    }

    /// 固定密码准入（Q2 方案 C）。顺序刻意与 [`Self::uno_admit`] 同构：
    /// 红线 → 政策 → 闸 → 验密 → 逐台禁止 → 落白名单 → 建会话。
    ///
    /// 与验码路径的四个差别：
    /// 1. 验密**之前**先过防爆破闸（[`Self::pass_gate`]）。验密本身要花本机
    ///    CPU/内存（Argon2id 19 MiB、几十毫秒），先闸后验同时按住「无限慢速
    ///    爆破」与「拿验密烤 CPU」两种玩法；
    /// 2. 局域网政策在闸之前：`wan=false`（默认）时非局域网来路直接拒。
    ///    判据由调用方用 `path_kind::of_conn` 对**活连接**实测后传入
    ///    （抽成 `is_lan` 参数也让 `rc/tests.rs` 能直接打这条路径）；
    /// 3. 验密通过即清闸档——建会话失败不算失败（他没在爆破，不该吃退避）；
    /// 4. 没有「消费」语义：密码可反复用，泄露后的止损 = 一键全局关闭 + 换密码。
    ///
    /// # 🔴 与验码共用同一条信任落点
    ///
    /// 验密通过 = 该设备写入 rc_devices（与现场配对同一张表），受横幅/历史/
    /// 禁止/免确认的常规管理。**不**自动开免确认——「知道密码」与「这台设备
    /// 可信」必须保持分离（`unop.rs` 模块注释，设计稿威胁表第三行）。
    pub(super) fn pass_admit(
        &self,
        peer: &str,
        requested: Capability,
        pass: &str,
        is_lan: bool,
        now_ms: i64,
    ) -> UnoAdmit {
        let short = &peer[..8.min(peer.len())];
        // 红线先行：未启用 = 一律拒，且不泄露密码对不对（与验码同一句话术）。
        if !self.enabled() {
            return UnoAdmit::Denied(
                Gate::Disabled.deny_reason().to_string(),
                Gate::Disabled.deny_code().to_string(),
            );
        }
        let Some(cfg) = unop::cfg_from(&self.cfg()) else {
            return UnoAdmit::Denied("对方未开启固定密码接入".into(), "uno_pass_off".into());
        };
        // 局域网政策（设计稿第四条）：默认仅局域网。中继 / 公网打洞都算跨网。
        if !cfg.wan && !is_lan {
            log::info!("[RC] {short} 密码接入被拒：来路非局域网，且本机未开「允许跨网」");
            return UnoAdmit::Denied(
                "对方的固定密码只允许同一局域网内使用（跨网需对方显式打开）".into(),
                "uno_pass_wan".into(),
            );
        }
        // 先查闸，后验密。
        match self.pass_gate.check(peer, now_ms) {
            unop::GateCheck::Wait(ms) => {
                log::info!("[RC] {short} 密码接入被限速：还需等 {ms}ms");
                return UnoAdmit::Denied(
                    format!("尝试过于频繁，请约 {} 秒后再试", (ms + 999) / 1000),
                    "uno_pass_throttled".into(),
                );
            }
            unop::GateCheck::Ok => {}
        }
        if !unop::verify(&cfg.phc, pass) {
            self.pass_gate.record_failure(peer, now_ms);
            log::info!("[RC] {short} 固定密码错误");
            return UnoAdmit::Denied("接入密码不正确".into(), "uno_pass_invalid".into());
        }
        // 验过了就清档：下面的失败（忙/写库）不是爆破，不该让他吃退避。
        self.pass_gate.record_success(peer);
        // 逐台禁止优先于密码：用户明确拉黑过的设备，密码不该替他翻案。
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return UnoAdmit::Denied(
                Gate::DeviceDenied.deny_reason().to_string(),
                Gate::DeviceDenied.deny_code().to_string(),
            );
        }
        // 落白名单（同验码路径）。设备名先占位，等对方自报。
        let name = {
            let n = self.peer_name(peer);
            if n.is_empty() {
                "新设备".to_string()
            } else {
                n
            }
        };
        if let Err(e) = self.store.rc_device_pair(peer, &name) {
            // 存储错误原文只进日志；deny 话术不携带本机路径/IO 细节。
            log::error!("[RC] {short} 密码准入写设备列表失败：{e}");
            return UnoAdmit::Denied(
                "对方暂时无法处理该接入请求".into(),
                "uno_pass_store_error".into(),
            );
        }
        // 申请档超过密码档 → 压档（配置损坏时按只看兜底，不放开）。
        let grant = cfg.capability().unwrap_or(Capability::View);
        let cap = if requested.allowed_by(grant) {
            requested
        } else {
            grant
        };
        let established = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            self.establish_inbound_with(&mut inner, peer, name, cap)
        };
        match established {
            Ok(_) => {
                log::info!("[RC] {short} 通过固定密码连入（{}）", cap.as_str());
                UnoAdmit::Admitted
            }
            Err(e) => {
                log::warn!("[RC] {short} 密码正确但建立会话失败：{e}");
                UnoAdmit::Denied(e, "busy".into())
            }
        }
    }

    /// 建立入站会话的**核心**（人工同意与方案 D 免确认共用）。
    ///
    /// 门禁在这里重查一遍：人工路径的申请与同意之间最长 120s，配置可能已变
    /// （TOCTOU）；免确认路径虽无间隔，同一套判据再走一遍成本为零。
    /// 只改 `inner.session`，**不碰 pending**——pending 的出入队由调用方负责
    /// （人工路径从 pending 里来；免确认路径压根没进过 pending）。
    fn establish_inbound_with(
        &self,
        inner: &mut Inner,
        peer: &str,
        peer_name: String,
        requested: Capability,
    ) -> Result<Session, String> {
        if !self.enabled() {
            return Err("本机已关闭「允许被远程协助」".into());
        }
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return Err("该设备已被禁止远程本机".into());
        }
        if !self.has_remote_trust(peer) {
            return Err("设备未配对".into());
        }
        // 本机已有进行中的会话时，不能硬覆盖（发起侧 request_session 有 [busy_local] 这道闸，
        // 被控侧之前漏了——补上。对照状态机：OutboundActive/InboundActive 都不能迁移到 InboundActive。
        if let Some(cur) = inner.session.as_ref() {
            if !can_transition(cur.phase, SessionPhase::InboundActive) {
                return Err("[busy_local] 本机已有进行中的远程会话，请先结束".into());
            }
        }
        let cap = if requested.allowed_by(self.max_capability()) {
            requested
        } else {
            self.max_capability()
        };
        let s = Session {
            id: new_session_id(now_ms()),
            peer: peer.to_string(),
            peer_name,
            capability: cap,
            phase: SessionPhase::InboundActive,
            started_ms: now_ms(),
            granted: true,
        };
        inner.session = Some(s.clone());
        // 新会话的推流所有权从头分配（上一场的标记必须清，否则第一个批准循环
        // 会误判「已有人推流」而拒绝回 Accept）。
        inner.inbound_streaming = false;
        Ok(s)
    }

    pub fn approve_inbound(&self, peer: &str) -> Result<Session, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let idx = inner
            .pending
            .iter()
            .position(|k| k.peer == peer)
            .ok_or("没有待确认的远程申请")?;
        let knock = inner.pending[idx].clone();
        let s = self.establish_inbound_with(&mut inner, peer, knock.peer_name, knock.capability)?;
        inner.pending.remove(idx);
        drop(inner);
        // B-b：人工批准 = 首次 elevate 确认。仅同步配对的设备在此写入 rc_devices，
        // 此后可开免确认/自动收文件；已是 rc 设备则幂等无操作。
        if let Err(e) = self.elevate_from_sync(peer) {
            log::warn!("[RC] 批准入站后 elevate 失败（不影响本次会话）：{e}");
        }
        self.emit_changed();
        Ok(s)
    }

    pub fn deny_inbound(&self, peer: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let before = inner.pending.len();
        inner.pending.retain(|k| k.peer != peer);
        if inner.pending.len() == before {
            return Err("没有待确认的远程申请".into());
        }
        Ok(())
    }

    /// 读最近若干条会话历史（前端展示用）。实现见 `rc/history.rs`。
    pub fn session_history(&self) -> Vec<serde_json::Value> {
        super::history::list_history(&self.store)
    }

    /// 清空全部会话历史（设置页「清空记录」）。实现见 `rc/history.rs`。
    pub fn clear_history(&self) -> Result<(), String> {
        super::history::clear_history(&self.store)
    }
}

/// 被控端任务入口：输入读取 + 画面推流（实现在 `rc/inbound.rs`）。
async fn spawn_inbound_video(
    peer: &str,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    conn: iroh::endpoint::Connection,
    peer_dgram: bool,
    peer_audio: bool,
) {
    let Some(svc) = global() else {
        return;
    };
    // G3：对端申请了系统声音 → 音频 worker 由 InboundVideo::run 启动
    svc.audio_set_peer_wants(peer_audio);
    let Some(video) =
        super::inbound::InboundVideo::try_new(svc.clone(), peer, send, conn, peer_dgram)
    else {
        svc.audio_reset();
        log::warn!("[RC] 被控推流启动前会话已结束，放弃推流");
        return;
    };
    video.run(recv).await;
}

pub fn cfg_enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_ENABLED).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}
