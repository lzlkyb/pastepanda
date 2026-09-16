//! 远程电脑服务层（方案 A：与同步配对/通道分离）。
//!
//! # 🔴 不认识 tauri
//!
//! 与 `sync/` 同一条界线。身份仍是共用的 `NodeIdentity`，
//! 但**设备信任表是 `rc_devices`**，通道在 `rc_enabled` 时自建 Endpoint。

use super::clipboard::{ClipWait, ClipboardState};
use super::join::{self, RcJoins};
use super::protocol::{Capability, RcFrame, SessionPhase, ALPN};
use super::session::{
    can_transition, gate_inbound, gate_outbound, is_active, new_session_id, Gate, Session,
    CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED,
};
use super::jpeg::jpeg_dimensions;
use super::net::{accept_loop, bind_rc_endpoint};
use super::notify::{NotifyFn, NotifyState, ScopeNotifyFn};
use super::stream_cfg::{profile_from_cfg, virtual_screen_from_cfg, StreamCfg, StreamOpts};
use crate::data_store::DataStore;
use crate::sync::identity::NodeIdentity;
use crate::sync::presence::{self, PresenceTable, PORT as PRESENCE_BASE_PORT};
use iroh::{Endpoint, EndpointAddr};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 活跃会话最长持续（毫秒）。超时后推流循环自动结束，避免无人值守挂死。
const SESSION_TTL_MS: i64 = 2 * 60 * 60 * 1000;
/// 剪贴板推送上限：按 **JSON 帧 UTF-8 字节**卡（控制帧 64KB，留余量）。
/// 中文 1 字 ≈ 3 字节，不能按字符数卡。
const CLIPBOARD_MAX_JSON_BYTES: usize = 48 * 1024;
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

pub struct RcService {
    store: DataStore,
    inner: Mutex<Inner>,
    running: Mutex<Option<Running>>,
    joins: Arc<RcJoins>,
    /// 发起端最近一帧（合成后）画面。
    last_frame: Mutex<Option<super::video::VideoFrame>>,
    /// 发起端 → 被控端的发送半流（R2 键鼠 / R3 剪贴板）。tokio Mutex：跨 await 持锁。
    outbound_send: tokio::sync::Mutex<Option<iroh::endpoint::SendStream>>,
    /// 剪贴板同步的状态与「跨会话串扰」不变量（见 `clipboard.rs`）。
    clip: ClipboardState,
    /// 被控端：推 JPEG 时的发送半流（End 帧用；发起端走 outbound_send）。
    inbound_send:
        tokio::sync::Mutex<Option<std::sync::Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>>>,
    /// 状态变化 / 画面范围变化 / 注入错误 三类前端通知的收口（见 `notify.rs`）。
    notify: NotifyState,
    /// 发起申请后台拨号失败（非阻塞 request）。status() 读出后由前端展示。
    last_outbound_error: Mutex<Option<String>>,
    /// 推流参数（画质 / 截取范围 / 强制 JPEG）+ 心跳与 RTT 活性（见 `stream_cfg.rs`）。
    stream: StreamCfg,
    /// 被控端：当前被按住的 vk / 鼠标键集合，会话收口时补发 up（防止 Ctrl/Shift/鼠标键卡死）。
    pressed: std::sync::Mutex<super::pressed::Pressed>,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    pending: Vec<InboundKnock>,
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

static GLOBAL: OnceLock<Arc<RcService>> = OnceLock::new();

pub fn install_global(svc: Arc<RcService>) {
    let _ = GLOBAL.set(svc);
}

pub fn global() -> Option<Arc<RcService>> {
    GLOBAL.get().cloned()
}

impl RcService {
    pub fn new(store: DataStore) -> Self {
        Self {
            store,
            inner: Mutex::new(Inner::default()),
            running: Mutex::new(None),
            joins: RcJoins::new(),
            last_frame: Mutex::new(None),
            outbound_send: tokio::sync::Mutex::new(None),
            clip: ClipboardState::new(),
            inbound_send: tokio::sync::Mutex::new(None),
            notify: NotifyState::new(),
            last_outbound_error: Mutex::new(None),
            stream: StreamCfg::new(),
            pressed: std::sync::Mutex::new(super::pressed::Pressed::new()),
        }
    }

    pub fn note_rtt(&self, rtt_ms: i64) {
        self.stream.note_rtt(rtt_ms);
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

    fn stream_opts_snapshot(&self) -> StreamOpts {
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

    fn emit_changed(&self) {
        self.notify.emit_changed();
    }

    /// 注入「对端改了画面范围」的回调（lib.rs 在 manage 之后调用）。
    pub fn set_scope_notify(&self, f: ScopeNotifyFn) {
        self.notify.set_scope_notify(f);
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

    fn set_inject_err(&self, msg: String) {
        self.notify.set_inject_err(msg);
    }

    pub fn take_inject_err(&self) -> Option<String> {
        self.notify.take_inject_err()
    }

    /// 发起端取最近一帧（JPEG bytes）。无画面返 None。
    pub fn latest_frame(&self) -> Option<super::video::VideoFrame> {
        self.last_frame.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_frame(&self, f: super::video::VideoFrame) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    fn clear_frame(&self) {
        *self.last_frame.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn session_is(&self, phase: SessionPhase, peer: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.phase == phase && s.peer == peer)
    }

    fn session_capability(&self) -> Option<Capability> {
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
    fn invalidate_clipboard(&self) {
        self.clip.invalidate();
    }

    /// 最近一次从被控端拉回的剪贴板文本（由接收循环写入）。
    pub fn take_remote_clipboard(&self) -> Option<String> {
        self.clip.take()
    }

    fn set_remote_clipboard(&self, t: String) {
        self.clip.set_from_peer(t);
    }

    pub fn joins(&self) -> Arc<RcJoins> {
        self.joins.clone()
    }

    fn cfg(&self) -> serde_json::Value {
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
        let presence = Arc::new(PresenceTable::new());
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

        // presence：宣告 RC 端口；is_paired 用**远程信任**（rc ∪ 同步），
        // 否则仅同步配对的对端收不到本机 RC 地址，局域网发现会失败。
        {
            let store = self.store.clone();
            let store_online = self.store.clone();
            presence::spawn(
                true,
                presence,
                me,
                port,
                Arc::new(move |id: &str| {
                    matches!(store.rc_device_get(id), Ok(Some(_)))
                        || matches!(store.device_get(id), Ok(Some(_)))
                }),
                // 听见对端「回来」→ 刷 rc_devices 在线（修纯 RC 配对永远 offline）
                Arc::new(move |id: &str| {
                    let _ = store_online.rc_device_touch(id, true);
                }),
                presence_running,
                RC_PRESENCE_PORT,
            );
        }

        Ok(())
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
        self.store.rc_device_pair(node_id, &n)
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
                    {
                        let mut inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
                        let Some(sess) = inner.session.as_mut() else {
                            // 用户已取消：关掉刚建好的流
                            drop(send);
                            drop(recv);
                            return;
                        };
                        if sess.id != session_id {
                            drop(send);
                            drop(recv);
                            return;
                        }
                        sess.phase = SessionPhase::OutboundActive;
                        sess.capability = accepted_cap;
                        sess.granted = true;
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

    /// 发起端：收 JPEG / 脏矩形 / 控制帧。
    ///
    /// 🔴 **不再合成再编码**：整帧与脏块 JPEG 原样交给前端画布合成，
    /// 避免「网络传脏矩形、本机却整帧 clone + 二次 JPEG」的白做功。
    fn spawn_outbound_video(&self, peer: &str, mut recv: iroh::endpoint::RecvStream) {
        let peer = peer.to_string();
        let Some(svc) = global() else { return };
        // 捕获本任务启动时那份会话 id：重连（同 peer 新会话）建立后，旧画面流任务
        // 收尾时只能按 id 收口，不能按 peer 误杀新会话。
        let my_id = {
            let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session
                .as_ref()
                .filter(|s| s.phase == SessionPhase::OutboundActive && s.peer == peer)
                .map(|s| s.id.clone())
        };
        let Some(my_id) = my_id else {
            log::warn!("[RC] 发起端画面流启动前会话已结束，放弃推流");
            return;
        };
        tauri::async_runtime::spawn(async move {
            use super::video::{read_incoming, Incoming};
            let mut pending_rect: Option<super::video::DirtyRect> = None;
            // 画布逻辑尺寸：整帧时从 JPEG 解出，脏块沿用
            let mut canvas_w: u32 = 0;
            let mut canvas_h: u32 = 0;
            loop {
                if !svc.session_is(SessionPhase::OutboundActive, &peer) {
                    break;
                }
                if svc.session_expired() {
                    log::info!("[RC] 发起端会话超过 TTL，自动结束");
                    svc.force_end_if_session(&my_id, "会话超时").await;
                    break;
                }
                match read_incoming(&mut recv).await {
                    Ok(Incoming::Control(bytes)) => match RcFrame::decode(&bytes) {
                        Ok(RcFrame::End { reason }) => {
                            log::info!("[RC] 对端结束：{reason}");
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            // 可能是 vrect 元数据或剪贴板回包
                            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if v.get("t").and_then(|x| x.as_str()) == Some("vrect") {
                                    pending_rect = Some(super::video::DirtyRect {
                                        x: v["x"].as_u64().unwrap_or(0) as u32,
                                        y: v["y"].as_u64().unwrap_or(0) as u32,
                                        w: v["w"].as_u64().unwrap_or(0) as u32,
                                        h: v["h"].as_u64().unwrap_or(0) as u32,
                                    });
                                } else if v.get("t").and_then(|x| x.as_str()) == Some("clip") {
                                    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                                        svc.set_remote_clipboard(t.to_string());
                                    }
                                } else if v.get("t").and_then(|x| x.as_str()) == Some("clip_err") {
                                    if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                        log::warn!("[RC] 剪贴板拉回失败：{e}");
                                        // 推进 seq：让 pull 立刻返回；内容为空表示失败
                                        svc.set_remote_clipboard(String::new());
                                    }
                                } else if v.get("t").and_then(|x| x.as_str()) == Some("pong") {
                                    if let Some(ts) = v.get("ts").and_then(|x| x.as_i64()) {
                                        let rtt = now_ms().saturating_sub(ts);
                                        svc.note_rtt(rtt);
                                    }
                                } else if v.get("t").and_then(|x| x.as_str()) == Some("inject_err") {
                                    if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                        log::warn!("[RC] 被控端注入失败：{e}");
                                        svc.set_inject_err(e.to_string());
                                    }
                                }
                            }
                        }
                    },
                    Ok(Incoming::Jpeg(f)) => {
                        let rect = pending_rect.take();
                        // 整帧：用轻量 JPEG 头读尺寸（不解像素）
                        if rect.is_none() {
                            if let Some((w, h)) = jpeg_dimensions(&f.jpeg) {
                                canvas_w = w;
                                canvas_h = h;
                            }
                        }
                        let (w, h) = (canvas_w, canvas_h);
                        svc.set_frame(super::video::VideoFrame {
                            width: w,
                            height: h,
                            jpeg: f.jpeg,
                            at_ms: chrono::Utc::now().timestamp_millis(),
                            full: rect.is_none(),
                            rect,
                            codec: super::video::FrameCodec::Jpeg,
                            key: rect.is_none(),
                        });
                    }
                    Ok(Incoming::H264 {
                        key,
                        width,
                        height,
                        data,
                    }) => {
                        svc.set_frame(super::video::VideoFrame {
                            width,
                            height,
                            jpeg: data,
                            at_ms: chrono::Utc::now().timestamp_millis(),
                            full: true,
                            rect: None,
                            codec: super::video::FrameCodec::H264,
                            key,
                        });
                    }
                    Err(e) => {
                        log::info!("[RC] 画面流结束：{e}");
                        break;
                    }
                }
            }
            // P0：收流失败 ≠ 用户点了结束，但会话必须收口，否则界面一直「可控」。
            // 先比对 id 再清槽位——新会话建立时会直接覆盖 outbound_send，不清不会漏，
            // 但若不比对，旧任务会把新会话的发送半流清掉。
            if svc.session_id_is(&my_id) {
                *svc.outbound_send.lock().await = None;
            }
            svc.force_end_if_session(&my_id, "画面流中断").await;
        });
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

        let req = RcFrame::Request { capability };
        crate::sync::transport::write_frame(&mut send, &req.encode()?).await?;
        let resp = RcFrame::decode(&crate::sync::transport::read_frame(&mut recv).await?)?;
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
        let mut send = w.send;
        let mut recv = w.recv;

        let deny = |reason: &str, code: &str| {
            RcFrame::Deny {
                reason: reason.to_string(),
                code: Some(code.to_string()),
            }
            .encode()
            .ok()
        };

        let Ok(bytes) = read_frame(&mut recv).await else {
            return;
        };
        let requested = match RcFrame::decode(&bytes) {
            Ok(RcFrame::Request { capability }) => capability,
            Ok(_) => {
                if let Some(b) = deny("期望 Request 帧", "not_request") {
                    let _ = write_frame(&mut send, &b).await;
                }
                return;
            }
            Err(e) => {
                log::warn!("[RC] {short} 帧解码失败：{e}");
                return;
            }
        };

        // 未配对（远程/同步都没有）+ 邀请门开着 → 记敲门，等用户核对指纹
        if !self.has_remote_trust(&peer) {
            let now = now_ms();
            // 红线「未启用 = 零可见零请求零费用」：rc_enabled 关闭时，即便邀请门开着，
            // 也不记入 pending、不 emit，只回 deny（门禁在下方 gate_inbound 也会拦，
            // 但这里先挡住，避免禁用期间出现可见的配对请求）。
            if self.enabled() && join::door_open(&self.store, now) && self.joins.knock(&peer, now) {
                if let Some(b) = deny("等待对方确认配对", "await_pair_confirm") {
                    let _ = write_frame(&mut send, &b).await;
                }
                log::info!("[RC] {short} 敲门配对，已记入待确认");
                self.emit_changed();
            } else {
                if let Some(b) = deny("尚未远程配对", "not_paired") {
                    let _ = write_frame(&mut send, &b).await;
                }
                log::info!("[RC] {short} 未远程配对，已拒绝");
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
            if let Some(b) = deny(gate.deny_reason(), gate.deny_code()) {
                let _ = write_frame(&mut send, &b).await;
            }
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
                if let Some(b) = deny("等待确认超时", "confirm_timeout") {
                    let _ = write_frame(&mut send, &b).await;
                }
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
                    // R1：推 JPEG 画面直到会话结束
                    spawn_inbound_video(&peer, send, recv).await;
                    return;
                }
                Some(Err(_)) => {
                    if let Some(b) = deny("对方拒绝或会话被占用", "rejected_or_busy") {
                        let _ = write_frame(&mut send, &b).await;
                    }
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

    /// 读最近若干条会话历史（前端展示用）。实现见 `rc/history.rs`。
    pub fn session_history(&self) -> Vec<serde_json::Value> {
        super::history::list_history(&self.store)
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
            Some(s) if is_active(s.phase) => now_ms() - s.started_ms > SESSION_TTL_MS,
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

/// 被控端：约 5fps 推流（脏矩形/自适应）+ 读输入帧（R2/R3）。
async fn spawn_inbound_video(
    peer: &str,
    send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
) {
    let peer = peer.to_string();
    let Some(svc) = global() else {
        return;
    };
    // 捕获本任务启动时那份会话 id：重连（同 peer 新会话）建立后，旧推流/输入任务
    // 收尾时只能按 id 收口，不能按 peer 误杀新会话。
    let my_id = {
        let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .session
            .as_ref()
            .filter(|s| s.phase == SessionPhase::InboundActive && s.peer == peer)
            .map(|s| s.id.clone())
    };
    let Some(my_id) = my_id else {
        log::warn!("[RC] 被控推流启动前会话已结束，放弃推流");
        return;
    };
    let send = std::sync::Arc::new(tokio::sync::Mutex::new(send));
    // 被控端结束会话时要用这条半流发 End
    {
        let ib = send.clone();
        let svc_ib = svc.clone();
        tauri::async_runtime::spawn(async move {
            *svc_ib.inbound_send.lock().await = Some(ib);
        });
    }

    // 输入读取任务
    {
        let peer2 = peer.clone();
        let svc2 = svc.clone();
        let send2 = send.clone();
        let my_id2 = my_id.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if !svc2.session_is(SessionPhase::InboundActive, &peer2) {
                    break;
                }
                match crate::sync::transport::read_frame(&mut recv).await {
                    Ok(bytes) => {
                        // 发起端结束会话：End 帧与 InputEvent 同半流
                        if let Ok(RcFrame::End { reason }) = RcFrame::decode(&bytes) {
                            log::info!("[RC] 对端结束会话：{reason}");
                            svc2.force_end_if_session(&my_id2, &reason).await;
                            break;
                        }
                        if let Ok(ev) = serde_json::from_slice::<super::input::InputEvent>(&bytes) {
                            // 任意输入/心跳都算活跃
                            svc2.touch_activity();
                            if let super::input::InputEvent::Ping { ts } = &ev {
                                // 回 pong，发起端测 RTT
                                let msg = serde_json::json!({ "t": "pong", "ts": ts });
                                if let Ok(b) = serde_json::to_vec(&msg) {
                                    let mut guard = send2.lock().await;
                                    let _ = crate::sync::transport::write_frame(&mut guard, &b).await;
                                }
                            } else {
                                handle_inbound_input(&svc2, &peer2, ev, &send2).await;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            // 输入半流断了：会话也要收口（对端崩溃 / 网络断）
            svc2
                .force_end_if_session(&my_id2, "控制通道断开")
                .await;
        });
    }

    let profile = svc.encode_profile();
    let virt = svc.capture_virtual_screen();
    svc.reset_stream_opts_from_cfg();
    let mut interval;
    let enc = std::sync::Arc::new(std::sync::Mutex::new(
        super::video::EncoderState::with_profile(profile, virt),
    ));
    // R4：主屏 + 允许硬编时优先 DXGI + H.264；失败回退 JPEG
    #[cfg(target_os = "windows")]
    let mut dxgi = super::dxgi::DxgiCapture::new();
    #[cfg(target_os = "windows")]
    let mut h264 = {
        let codec = svc
            .cfg()
            .get(CFG_CODEC)
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        if codec == "jpeg" || virt {
            None
        } else {
            let p = svc.encode_profile();
            let fps = (1000 / p.interval_ms.max(50)).clamp(5, 30) as u32;
            let enc = super::encode_h264::H264SessionEncoder::try_open(1280, 720, fps);
            if enc.available() {
                log::info!("[RC] H.264 硬编已启用");
                Some(enc)
            } else {
                None
            }
        }
    };
    // 会话刚建立：立刻可推流，等首个心跳
    svc.touch_activity();
    loop {
        if !svc.session_is(SessionPhase::InboundActive, &peer) {
            break;
        }
        if svc.session_expired() {
            log::info!("[RC] 会话超过 TTL，自动结束");
            svc.force_end_if_session(&my_id, "会话超时").await;
            break;
        }
        if svc.should_pause_stream() {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            continue;
        }
        let opts = svc.stream_opts_snapshot();
        interval = opts.profile.interval_ms;
        {
            let mut st = enc.lock().unwrap_or_else(|p| p.into_inner());
            if st.profile() != &opts.profile
                || st.virtual_screen_flag() != opts.virtual_screen
                || st.monitor() != opts.monitor
            {
                st.apply_profile(opts.profile, opts.virtual_screen);
                if opts.monitor >= 0 {
                    st.apply_monitor(opts.monitor);
                }
            }
        }

        // —— R4 硬编路径（仅主屏、未指定单屏、未强制 JPEG）——
        #[cfg(target_os = "windows")]
        if let Some(henc) = h264.as_mut() {
            if henc.available() && !opts.virtual_screen && opts.monitor < 0 && !opts.force_jpeg {
                match dxgi.grab() {
                    Ok(Some((w, h, bgra))) => match henc.encode_bgra(&bgra, w, h) {
                        Ok(pkts) => {
                            if !pkts.is_empty() {
                                let mut guard = send.lock().await;
                                let mut failed = false;
                                for p in pkts {
                                    if super::video::write_h264(
                                        &mut guard,
                                        &p.data,
                                        p.key,
                                        p.width,
                                        p.height,
                                    )
                                    .await
                                    .is_err()
                                    {
                                        failed = true;
                                        break;
                                    }
                                }
                                drop(guard);
                                if failed {
                                    svc.force_end_if_session(&my_id, "H.264 推送失败").await;
                                    break;
                                }
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                            continue;
                        }
                        Err(e) => {
                            log::debug!("[RC] H.264 编码失败，本帧回退 JPEG：{e}");
                        }
                    },
                    Ok(None) => {
                        tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                        continue;
                    }
                    Err(_) => {}
                }
            }
        }

        let enc2 = enc.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut st = enc2.lock().unwrap_or_else(|p| p.into_inner());
            super::video::capture_and_encode(&mut st)
        })
        .await;
        match result {
            Ok(Ok(enc_out)) => {
                if enc_out.frame.jpeg.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                    continue;
                }
                let mut guard = send.lock().await;
                if let Some(r) = enc_out.rect {
                    if let Err(e) = super::video::write_dirty_meta(&mut guard, r).await {
                        log::info!("[RC] 脏矩形元数据写失败：{e}");
                        drop(guard);
                        svc.force_end_if_session(&my_id, "画面推送失败").await;
                        break;
                    }
                }
                if super::video::write_jpeg(&mut guard, &enc_out.frame.jpeg).await.is_err() {
                    log::info!("[RC] 画面写入失败，停止推流");
                    drop(guard);
                    svc.force_end_if_session(&my_id, "画面推送失败").await;
                    break;
                }
            }
            Ok(Err(e)) => {
                log::debug!("[RC] 截帧失败：{e}");
            }
            Err(e) => {
                log::warn!("[RC] 截帧任务失败：{e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
    }
    log::info!("[RC] 被控推流已停止");
    // 先比对 id 再清槽位——新会话建立时会直接覆盖 inbound_send，不清不会漏，
    // 但不比对会让旧任务清掉新会话的发送半流。
    if svc.session_id_is(&my_id) {
        *svc.inbound_send.lock().await = None;
    }
}

/// 被控端处理一条输入（R2）。UIPI / 只看档必须报错不静默。
async fn handle_inbound_input(
    svc: &Arc<RcService>,
    peer: &str,
    ev: super::input::InputEvent,
    send: &std::sync::Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
) {
    use super::input::InputEvent;
    let cap = match svc.session_capability() {
        Some(c) => c,
        None => return,
    };

    match &ev {
        InputEvent::ClipboardPush { text } => {
            if super::input::assert_control_allowed(cap).is_err() {
                return;
            }
            if let Err(e) = super::input::set_clipboard_text(text) {
                log::warn!("[RC] 写入被控剪贴板失败：{e}");
            }
            return;
        }
        InputEvent::ClipboardPull => {
            if super::input::assert_control_allowed(cap).is_err() {
                return;
            }
            match super::input::get_clipboard_text() {
                Ok(t) => {
                    // 回包也走控制帧 64KB：过大时明确报错，不要静默失败
                    let msg = if t.len() > CLIPBOARD_MAX_JSON_BYTES {
                        serde_json::json!({
                            "t": "clip_err",
                            "error": "对方剪贴板过大，无法拉取",
                        })
                    } else {
                        serde_json::json!({ "t": "clip", "text": t })
                    };
                    if let Ok(b) = serde_json::to_vec(&msg) {
                        let mut guard = send.lock().await;
                        let _ = crate::sync::transport::write_frame(&mut guard, &b).await;
                    }
                }
                Err(e) => {
                    log::warn!("[RC] 读被控剪贴板失败：{e}");
                    let msg = serde_json::json!({ "t": "clip_err", "error": format!("读剪贴板失败：{e}") });
                    if let Ok(b) = serde_json::to_vec(&msg) {
                        let mut guard = send.lock().await;
                        let _ = crate::sync::transport::write_frame(&mut guard, &b).await;
                    }
                }
            }
            return;
        }
        // 流控（画质/范围/编码）不注入本机输入，只看会话也允许调整
        InputEvent::SetQuality { quality } => {
            if let Err(e) = svc.set_stream_quality(quality) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求画质档：{quality}");
            }
            return;
        }
        InputEvent::SetCaptureScope { scope } => {
            if let Err(e) = svc.set_stream_scope(scope) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求画面范围：{scope}");
                // B3：被控端必须看得见这次变更。只 log 等于没提示——用户不知道
                // 自己的画面（可能含隐私内容）被切到了别处。
                svc.emit_scope_changed(scope);
            }
            return;
        }
        InputEvent::SetCodec { codec } => {
            if let Err(e) = svc.set_stream_codec(codec) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求编码：{codec}");
            }
            return;
        }
        _ => {}
    }

    if super::input::assert_control_allowed(cap).is_err() {
        log::debug!("[RC] 拒绝只看会话的键鼠注入");
        return;
    }

    // 追踪按下/抬起：会话收口时由 end_session 调 release_all 补发 up，
    // 避免对端断线后 Ctrl/Shift/鼠标键永久卡在按下态。只在会真正注入时记录。
    match &ev {
        InputEvent::Key { vk, down } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                g.press_key(*vk);
            } else {
                g.release_key(*vk);
            }
        }
        InputEvent::MouseButton { button, down, .. } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                g.press_button(*button);
            } else {
                g.release_button(*button);
            }
        }
        _ => {}
    }

    let region = {
        let opts = svc.stream_opts_snapshot();
        if opts.monitor >= 0 {
            match crate::screenshot::monitor_region(opts.monitor) {
                Ok((x, y, w, h)) => super::input::ScreenRegion { x, y, w, h },
                Err(_) => super::input::ScreenRegion::virtual_screen(),
            }
        } else if opts.virtual_screen {
            super::input::ScreenRegion::virtual_screen()
        } else {
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
                };
                let (w, h) =
                    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
                super::input::ScreenRegion {
                    x: 0,
                    y: 0,
                    w: w.max(1),
                    h: h.max(1),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                super::input::ScreenRegion::virtual_screen()
            }
        }
    };
    let r = super::input::inject(&ev, &region);
    if !r.ok {
        log::warn!("[RC] 键鼠注入失败（{peer}）：{}", r.error);
        // P1：UIPI 等失败要让发起端看见，不能只写日志
        let msg = serde_json::json!({ "t": "inject_err", "error": r.error });
        if let Ok(b) = serde_json::to_vec(&msg) {
            let mut guard = send.lock().await;
            let _ = crate::sync::transport::write_frame(&mut guard, &b).await;
        }
        if let Some(svc) = global() {
            svc.set_inject_err(r.error.clone());
        }
    }
}

pub fn cfg_enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_ENABLED).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}
