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
use super::protocol::{Capability, RcFrame, SessionPhase, ALPN};
use super::session::{
    can_transition, gate_inbound, gate_outbound, new_session_id, Gate, Session, CFG_CAPABILITY,
    CFG_DEVICE_DENY, CFG_ENABLED,
};
use super::net::{accept_loop, bind_rc_endpoint};
use super::notify::{NotifyFn, NotifyState, PathNotifyFn, ScopeNotifyFn};
use super::stream_cfg::{profile_from_cfg, virtual_screen_from_cfg, StreamCfg, StreamOpts};
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

/// RC 地址宣告端口。**不是**同步的 5008，两套 presence 互不抢 bind。
pub const RC_PRESENCE_PORT: u16 = PRESENCE_BASE_PORT + 1;

/// 给界面看的完整状态。
#[derive(Debug, Clone, Serialize, Default)]
pub struct RcStatus {
    pub enabled: bool,
    pub capability: String,
    pub session: Option<Session>,
    pub pending: Vec<InboundKnock>,
    /// 生成邀请后、等对方核对指纹敲门的列表。
    pub joins: Vec<join::RcJoinRequest>,
    pub device_deny: HashMap<String, bool>,
    /// 通道是否已起来（rc_enabled 且端点绑定成功）。
    pub running: bool,
    /// 画质档 sharp/balanced/smooth
    pub quality: String,
    /// 截取范围 virtual/primary
    pub capture_scope: String,
    /// 发起端最近 RTT（毫秒），0=尚未测到。
    pub rtt_ms: i64,
    /// 会话链路实际走的路：`lan` / `direct` / `relay`；空串 = 未测到（前端不显示这格）。
    pub path_kind: String,
    /// 最后一次收到对端 pong 的时刻（epoch ms）；0 = 本会话还没收到过。
    ///
    /// 🔴 前端**只**用它判链路活性。ping 的本地 `invoke` 成功只说明消息进了
    /// 本地发送队列，不代表对端收到了——那是 2026-09-17 修掉的另一个误报源。
    pub last_pong_ms: i64,
    /// 非阻塞发起申请的后台失败原因；前端展示后应调 clear_outbound_error。
    pub outbound_error: Option<String>,
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
    /// 发起端 → 被控端的发送半流（R2 键鼠 / R3 剪贴板）。tokio Mutex：跨 await 持锁。
    pub(super) outbound_send: tokio::sync::Mutex<Option<iroh::endpoint::SendStream>>,
    /// 剪贴板同步的状态与「跨会话串扰」不变量（见 `clipboard.rs`）。
    clip: ClipboardState,
    /// 被控端：推 JPEG 时的发送半流（End 帧用；发起端走 outbound_send）。
    pub(super) inbound_send:
        tokio::sync::Mutex<Option<std::sync::Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>>>,
    /// 状态变化 / 画面范围变化 / 注入错误 三类前端通知的收口（见 `notify.rs`）。
    pub(super) notify: NotifyState,
    /// 发起申请后台拨号失败（非阻塞 request）。status() 读出后由前端展示。
    pub(super) last_outbound_error: Mutex<Option<String>>,
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
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) session: Option<Session>,
    pub(super) pending: Vec<InboundKnock>,
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
fn explain(conn: &iroh::endpoint::Connection, err: String) -> String {
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
            outbound_send: tokio::sync::Mutex::new(None),
            clip: ClipboardState::new(),
            inbound_send: tokio::sync::Mutex::new(None),
            notify: NotifyState::new(),
            last_outbound_error: Mutex::new(None),
            stream: StreamCfg::new(),
            link: LinkState::new(),
            pressed: std::sync::Mutex::new(super::pressed::Pressed::new()),
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
        self.stream
            .reset_from_cfg(self.encode_profile(), self.capture_virtual_screen());
    }

    /// 发起端在会话中改画质。
    pub fn set_stream_quality(&self, quality: &str) -> Result<(), String> {
        self.stream.set_quality(quality)
    }

    /// 被控端：对端上报 RTT，返回当前 H.264 码率缩放（%）。
    pub fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        self.stream.set_peer_rtt(rtt_ms)
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

    pub(super) fn emit_changed(&self) {
        self.notify.emit_changed();
    }

    /// 注入「对端改了画面范围」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_scope_notify(&self, f: ScopeNotifyFn) {
        self.notify.set_scope_notify(f);
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

    pub(super) fn set_inject_err(&self, msg: String) {
        self.notify.set_inject_err(msg);
    }

    pub fn take_inject_err(&self) -> Option<String> {
        self.notify.take_inject_err()
    }

    /// 发起端取最近一帧（JPEG bytes）。无画面返 None。
    pub fn latest_frame(&self) -> Option<super::video::VideoFrame> {
        self.last_frame.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub(super) fn set_frame(&self, f: super::video::VideoFrame) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    pub(super) fn clear_frame(&self) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = None;
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
    /// 键鼠与剪贴板要求 Control；**Ping 与流控（画质/范围/编码）只看会话也可发**——
    /// 否则 View 会话发不出心跳，被控端 3.5s 后暂停推流，画面永久冻结。
    pub async fn send_input(&self, ev: &super::input::InputEvent) -> Result<(), String> {
        use super::input::InputEvent;
        let needs_control = !matches!(
            ev,
            InputEvent::Ping { .. }
                | InputEvent::NetHint { .. }
                | InputEvent::SetQuality { .. }
                | InputEvent::SetCaptureScope { .. }
                | InputEvent::SetCodec { .. }
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
        let mut guard = self.outbound_send.lock().await;
        let Some(send) = guard.as_mut() else {
            return Err("发送通道不可用".into());
        };
        let json = serde_json::to_vec(ev).map_err(|e| e.to_string())?;
        crate::sync::transport::write_frame(send, &json).await
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
        self.send_input(&super::input::InputEvent::ClipboardPull).await?;
        let deadline = now_ms() + CLIPBOARD_PULL_TIMEOUT_MS;
        while now_ms() < deadline {
            match self.clip.decision(epoch, before) {
                ClipWait::Take => return Ok(self.clip.take()),
                ClipWait::Abandon => return Ok(None),
                ClipWait::KeepWaiting => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
        Ok(None)
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
    fn is_rc_paired(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(_)))
    }

    /// 远程信任（方案 A 单向继承）：远程配对 **或** 同步配对。
    ///
    /// 同步配对的设备可直接发起/接受远程；远程配对**不会**自动进同步。
    pub fn has_remote_trust(&self, node_id: &str) -> bool {
        if self.is_rc_paired(node_id) {
            return true;
        }
        matches!(self.store.device_get(node_id), Ok(Some(_)))
    }

    /// 同步设备首次用于远程时写入 rc_devices（幂等），便于 presence 勾选与列表稳定。
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

    fn peer_name(&self, node_id: &str) -> String {
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
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner()).is_some();
        RcStatus {
            enabled: self.enabled(),
            capability: self.max_capability().as_str().to_string(),
            session: inner.session.clone(),
            pending: inner.pending.clone(),
            joins: self.joins.list(now_ms()),
            device_deny: self.device_deny(),
            running,
            quality: self
                .cfg()
                .get(CFG_QUALITY)
                .and_then(|v| v.as_str())
                .unwrap_or("balanced")
                .to_string(),
            capture_scope: self
                .cfg()
                .get(CFG_CAPTURE_SCOPE)
                .and_then(|v| v.as_str())
                .unwrap_or("virtual")
                .to_string(),
            rtt_ms: self.last_rtt_ms(),
            path_kind: self.link.path_kind_str(),
            last_pong_ms: self.link.last_pong_ms(),
            // clone 而非 take：Overlay/对话框/设置多处 useRc 并发轮询，take 会只有一处看见
            outbound_error: self
                .last_outbound_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap_or_else(|p| p.into_inner()).is_some()
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
            *self.inbound_send.lock().await = None;
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

    fn transport_ready(&self) -> Option<(Endpoint, Arc<PresenceTable>)> {
        let g = self.running.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().map(|r| (r.endpoint.clone(), r.presence.clone()))
    }

    /// 非阻塞发起远程：立刻落 OutboundPending 并返回，dial 在后台跑。
    /// 前端可立即展示等待 UI 并取消；结果经 `rc-session-changed` / `outbound_error` 回传。
    pub async fn request_session(
        &self,
        peer: &str,
        capability: Capability,
    ) -> Result<Session, String> {
        let (session_id, pending_sess) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if gate_outbound(inner.session.is_some()) == Gate::Busy {
                return Err("[busy_local] 已有进行中的远程会话，请先结束".into());
            }
            if !self.has_remote_trust(peer) {
                return Err("[not_paired] 尚未完成远程配对：请先在远程电脑设置里配对这台设备".into());
            }
            if !self.is_running() {
                return Err("[channel_down] 远程通道未启动：请先开启远程通道或完成远程配对".into());
            }
            // 同步设备首次发起远程 → 写入 rc_devices（方案 A）
            if let Err(e) = self.elevate_from_sync(peer) {
                log::warn!("[RC] 从同步配对提升到远程失败：{e}");
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
            match svc.dial_and_request(&peer, capability).await {
                Ok((accepted_cap, send, recv)) => {
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
                        return;
                    }
                    let _ = svc.store.rc_device_touch(&peer, true);
                    svc.clear_frame();
                    svc.note_rtt(0);
                    *svc.outbound_send.lock().await = Some(send);
                    svc.spawn_outbound_video(&peer, recv);
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
    fn spawn_outbound_video(&self, peer: &str, recv: iroh::endpoint::RecvStream) {
        let Some(svc) = global() else { return };
        let Some(video) = super::outbound::OutboundVideo::try_new(svc, peer, recv) else {
            log::warn!("[RC] 发起端画面流启动前会话已结束，放弃推流");
            return;
        };
        tauri::async_runtime::spawn(video.run());
    }

    /// 轻量探活：拨通即认为可达，立刻断开（不建会话、不发 Request）。
    /// 成功则 `touch(true)` 刷 last_seen。给设备列表「按需探活」用。
    pub async fn probe_peer(&self, peer: &str) -> Result<(), String> {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer)
            .map_err(|e| format!("node_id 解不开：{}", e))?;
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
        let _ = self.store.rc_device_touch(peer, true);
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
    ) -> Result<
        (
            Capability,
            iroh::endpoint::SendStream,
            iroh::endpoint::RecvStream,
        ),
        String,
    > {
        let Some((ep, presence)) = self.transport_ready() else {
            return Err("[channel_down] 远程通道未启动".into());
        };
        let id = iroh::EndpointId::from_str(peer).map_err(|e| format!("[bad_node_id] node_id 解不开：{}", e))?;
        let mut addr = EndpointAddr::new(id);
        for sock in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(sock);
        }

        let conn = ep
            .connect(addr, ALPN)
            .await
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

        let req = RcFrame::Request { capability };
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
            RcFrame::Accept { capability } => Ok((capability, send, recv)),
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
        let requested = match RcFrame::decode(&bytes) {
            Ok(RcFrame::Request { capability }) => capability,
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

        // 未配对（远程/同步都没有）+ 邀请门开着 → 记敲门，等用户核对指纹
        if !self.has_remote_trust(&peer) {
            let now = now_ms();
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
                    deny_and_close(&link_conn, &mut send, "等待对方确认配对", "await_pair_confirm")
                        .await;
                    log::info!("[RC] {short} 敲门配对，已记入待确认");
                    self.emit_changed();
                }
            }
            return;
        }

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

        {
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
        // 有申请进来立刻通知前端（窗口隐藏时也能 toast）
        self.emit_changed();

        let deadline = now_ms() + 120_000;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if now_ms() > deadline {
                self.clear_pending(&peer);
                deny_and_close(&link_conn, &mut send, "等待确认超时", "confirm_timeout").await;
                return;
            }
            let decision = {
                let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                match inner.session.as_ref() {
                    Some(s) if s.peer == peer && s.phase == SessionPhase::InboundActive => {
                        Some(Ok(s.capability))
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
                }
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
                    // R1：推 JPEG 画面直到会话结束
                    spawn_inbound_video(&peer, send, recv).await;
                    return;
                }
                Some(Err(_)) => {
                    deny_and_close(&link_conn, &mut send, "对方拒绝或会话被占用", "rejected_or_busy")
                        .await;
                    self.clear_pending(&peer);
                    return;
                }
                None => continue,
            }
        }
    }

    fn clear_pending(&self, peer: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.pending.retain(|k| k.peer != peer);
    }

    pub fn approve_inbound(&self, peer: &str) -> Result<Session, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let idx = inner
            .pending
            .iter()
            .position(|k| k.peer == peer)
            .ok_or("没有待确认的远程申请")?;
        // 同意时重查门禁：申请与同意之间最长 120s，配置可能已变（TOCTOU）
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
        let knock = inner.pending.remove(idx);
        let cap = if knock.capability.allowed_by(self.max_capability()) {
            knock.capability
        } else {
            self.max_capability()
        };
        let s = Session {
            id: new_session_id(now_ms()),
            peer: peer.to_string(),
            peer_name: knock.peer_name,
            capability: cap,
            phase: SessionPhase::InboundActive,
            started_ms: now_ms(),
            granted: true,
        };
        inner.session = Some(s.clone());
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
}

/// 被控端任务入口：输入读取 + 画面推流（实现在 `rc/inbound.rs`）。
async fn spawn_inbound_video(
    peer: &str,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
) {
    let Some(svc) = global() else {
        return;
    };
    let Some(video) = super::inbound::InboundVideo::try_new(svc, peer, send) else {
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
