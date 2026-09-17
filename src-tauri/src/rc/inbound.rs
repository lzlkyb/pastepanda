//! 被控端会话的两条任务：输入读取/处理、画面推流（Tier C 从 `service.rs` 拆出）。
//!
//! 拆法是「循环体类型化」而不是搬家：推流循环原来是一个 232 行函数，把「会话
//! 判定 / TTL / 心跳暂停 / 硬编优先 / JPEG 回退 / 失败收口」全部内联在三层嵌套
//! 里。现在圈起来一个 `InboundVideo` 结构体（持有 svc / 会话 id / 发送半流 /
//! 编码器 / Windows 硬编资源），每圈是一个显式的 `Step` 决策——改哪条路径、
//! 失败收不收口，一眼可见。
//!
//! 🔴 `my_id` 是 A2 修复的关键：任务启动时捕获**当时**那份会话 id，之后所有
//! 收口只按 id 命中（`force_end_if_session`），不能按 peer——否则重连后旧任务
//! 会误杀新会话（「点重连画面闪一下又断」）。
//!
//! ⚠️ 本模块的 async 方法一律取 `&mut self` 而不是 `&self`。不是随手写法：
//! async fn 的 future 会把参数（含 `&self`）持有到 future 结束，而
//! `tauri::async_runtime::spawn` 要求 `Send`——`&InboundVideo` 需要
//! `InboundVideo: Sync`（`DxgiCapture` 里面是 `NonNull<c_void>`，不是），
//! `&mut InboundVideo` 只需要 `Send`（owned 的 `DxgiCapture` 是）。改回
//! `&self` 会在 net.rs 的 spawn 处报「future cannot be sent」。

use std::sync::Arc;

use super::input::{assert_control_allowed, get_clipboard_text, inject, set_clipboard_text};
use super::input::{InputEvent, ScreenRegion};
use super::protocol::{RcFrame, SessionPhase};
use super::service::{RcService, CLIPBOARD_MAX_JSON_BYTES, CFG_CODEC, CFG_QUALITY};
use crate::sync::transport::{read_frame, write_frame};

/// 被控端推流任务。
pub(super) struct InboundVideo {
    svc: Arc<RcService>,
    peer: String,
    /// 任务启动时的会话 id；收口只认它。
    my_id: String,
    /// 输入与画面共用的发送半流（对端收到的一切都从这里出去）。
    send: Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
    enc: Arc<std::sync::Mutex<super::video::EncoderState>>,
    #[cfg(target_os = "windows")]
    dxgi: super::dxgi::DxgiCapture,
    /// R4 硬编会话；None = 不走硬编（配置 jpeg / 抓整屏 / 打不开）。
    #[cfg(target_os = "windows")]
    h264: Option<super::encode_h264::H264SessionEncoder>,
}

/// 一圈推流的走向。命名决策替代三层嵌套 match。
enum Step {
    /// 本圈无事或已推完：睡到下一帧间隔。
    Sleep,
    /// 推送失败：已收口，退出循环。
    End,
    /// 硬编这条路没走成，落回 JPEG 路径。
    FallThrough,
}

impl InboundVideo {
    /// 会话存在、是入站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(super) fn try_new(
        svc: Arc<RcService>,
        peer: &str,
        send: iroh::endpoint::SendStream,
    ) -> Option<Self> {
        let my_id = {
            let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session
                .as_ref()
                .filter(|s| s.phase == SessionPhase::InboundActive && s.peer == peer)
                .map(|s| s.id.clone())
        }?;
        let send = Arc::new(tokio::sync::Mutex::new(send));
        let profile = svc.encode_profile();
        let virt = svc.capture_virtual_screen();
        svc.reset_stream_opts_from_cfg();
        let enc = Arc::new(std::sync::Mutex::new(super::video::EncoderState::with_profile(
            profile, virt,
        )));
        // R4：主屏 + 允许硬编时优先 DXGI + H.264；失败回退 JPEG
        #[cfg(target_os = "windows")]
        let h264 = Self::open_h264(&svc, virt);
        Some(Self {
            svc,
            peer: peer.to_string(),
            my_id,
            send,
            enc,
            #[cfg(target_os = "windows")]
            dxgi: super::dxgi::DxgiCapture::new(),
            #[cfg(target_os = "windows")]
            h264,
        })
    }

    /// R5.B 硬编会话：配置强制 JPEG 或抓整屏时不开；打不开也回 None（走 JPEG）。
    /// 打开尺寸跟**主屏物理分辨率**走，不再写死 1280×720（否则 4K 会先错开再重开）。
    #[cfg(target_os = "windows")]
    fn open_h264(
        svc: &Arc<RcService>,
        virt: bool,
    ) -> Option<super::encode_h264::H264SessionEncoder> {
        let codec = svc
            .cfg()
            .get(CFG_CODEC)
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        if codec == "jpeg" || virt {
            return None;
        }
        let p = svc.encode_profile();
        // uhd 档目标 15fps；其余跟 JPEG 档 interval，硬编至少 10fps
        let fps = if svc.cfg().get(CFG_QUALITY).and_then(|v| v.as_str()) == Some("uhd") {
            15
        } else {
            (1000 / p.interval_ms.max(50)).clamp(10, 30) as u32
        };
        let (pw, ph) = primary_screen_size();
        let enc = super::encode_h264::H264SessionEncoder::try_open(pw, ph, fps);
        if enc.available() {
            log::info!("[RC] H.264 硬编已启用 @ {pw}x{ph} {fps}fps");
            Some(enc)
        } else {
            None
        }
    }

    /// 被控端结束会话时要用这条半流发 End（入站收口路径读它）。
    async fn register_send_slot(&mut self) {
        let ib = self.send.clone();
        let svc = self.svc.clone();
        tauri::async_runtime::spawn(async move {
            *svc.inbound_send.lock().await = Some(ib);
        });
    }

    /// 输入读取任务：End 帧收口；其余解成 InputEvent，心跳回 pong，其它交
    /// `handle_inbound_input`。半流断开同样收口（对端崩溃 / 网络断）。
    fn spawn_input_reader(&self, mut recv: iroh::endpoint::RecvStream) {
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let send = self.send.clone();
        let my_id = self.my_id.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if !svc.session_is(SessionPhase::InboundActive, &peer) {
                    break;
                }
                match read_frame(&mut recv).await {
                    Ok(bytes) => {
                        // 发起端结束会话：End 帧与 InputEvent 同半流
                        if let Ok(RcFrame::End { reason }) = RcFrame::decode(&bytes) {
                            log::info!("[RC] 对端结束会话：{reason}");
                            svc.force_end_if_session(&my_id, &reason).await;
                            break;
                        }
                        if let Ok(ev) = serde_json::from_slice::<InputEvent>(&bytes) {
                            // 任意输入/心跳都算活跃
                            svc.touch_activity();
                            if let InputEvent::Ping { ts } = &ev {
                                // 回 pong，发起端测 RTT
                                let msg = serde_json::json!({ "t": "pong", "ts": ts });
                                if let Ok(b) = serde_json::to_vec(&msg) {
                                    let mut guard = send.lock().await;
                                    let _ = write_frame(&mut guard, &b).await;
                                }
                            } else {
                                handle_inbound_input(&svc, &peer, ev, &send).await;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            // 输入半流断了：会话也要收口（对端崩溃 / 网络断）
            svc.force_end_if_session(&my_id, "控制通道断开").await;
        });
    }

    /// R4 硬编路径：仅主屏、未指定单屏、未强制 JPEG 时尝试 DXGI + H.264。
    async fn try_hardware_path(&mut self, opts: &super::stream_cfg::StreamOpts) -> Step {
        #[cfg(target_os = "windows")]
        {
            let Some(henc) = self.h264.as_mut() else {
                return Step::FallThrough;
            };
            if !(henc.available() && !opts.virtual_screen && opts.monitor < 0 && !opts.force_jpeg)
            {
                return Step::FallThrough;
            }
            // R5.B2：按对端 RTT 缩码率（变化够大才重开编码器）
            let scale = self.svc.bitrate_scale();
            henc.apply_bitrate_scale(scale);
            match self.dxgi.grab() {
                Ok(Some((w, h, bgra))) => match henc.encode_bgra(&bgra, w, h) {
                    Ok(pkts) => {
                        if !pkts.is_empty() {
                            let mut guard = self.send.lock().await;
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
                                self.svc
                                    .force_end_if_session(&self.my_id, "H.264 推送失败")
                                    .await;
                                return Step::End;
                            }
                        }
                        Step::Sleep
                    }
                    Err(e) => {
                        log::debug!("[RC] H.264 编码失败，本帧回退 JPEG：{e}");
                        Step::FallThrough
                    }
                },
                Ok(None) => Step::Sleep,
                Err(_) => Step::FallThrough,
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = opts;
            Step::FallThrough
        }
    }

    /// JPEG 路径：阻塞截帧+编码丢进 spawn_blocking，写脏矩形元数据 + JPEG。
    /// 写失败 = 对端/链路没了，收口退出。
    async fn jpeg_path(&mut self, interval: u64) -> Step {
        let enc = self.enc.clone();
        let result =
            tokio::task::spawn_blocking(move || {
                let mut st = enc.lock().unwrap_or_else(|p| p.into_inner());
                super::video::capture_and_encode(&mut st)
            })
            .await;
        match result {
            Ok(Ok(enc_out)) => {
                if enc_out.frame.jpeg.is_empty() {
                    return Step::Sleep;
                }
                let mut guard = self.send.lock().await;
                if let Some(r) = enc_out.rect {
                    if let Err(e) = super::video::write_dirty_meta(&mut guard, r).await {
                        log::info!("[RC] 脏矩形元数据写失败：{e}");
                        drop(guard);
                        self.svc
                            .force_end_if_session(&self.my_id, "画面推送失败")
                            .await;
                        return Step::End;
                    }
                }
                if super::video::write_jpeg(&mut guard, &enc_out.frame.jpeg)
                    .await
                    .is_err()
                {
                    log::info!("[RC] 画面写入失败，停止推流");
                    drop(guard);
                    self.svc
                        .force_end_if_session(&self.my_id, "画面推送失败")
                        .await;
                    return Step::End;
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
        Step::Sleep
    }

    pub(super) async fn run(mut self, recv: iroh::endpoint::RecvStream) {
        // 被控端结束会话时要用这条半流发 End
        self.register_send_slot().await;
        self.spawn_input_reader(recv);
        // 会话刚建立：立刻可推流，等首个心跳
        self.svc.touch_activity();
        loop {
            if !self.svc.session_is(SessionPhase::InboundActive, &self.peer) {
                break;
            }
            if self.svc.session_expired() {
                log::info!("[RC] 会话超过 TTL，自动结束");
                self.svc.force_end_if_session(&self.my_id, "会话超时").await;
                break;
            }
            if self.svc.should_pause_stream() {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                continue;
            }
            let opts = self.svc.stream_opts_snapshot();
            let interval = opts.profile.interval_ms;
            {
                let mut st = self.enc.lock().unwrap_or_else(|p| p.into_inner());
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
            match self.try_hardware_path(&opts).await {
                Step::Sleep => {
                    tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                    continue;
                }
                Step::End => break,
                Step::FallThrough => {}
            }
            if let Step::End = self.jpeg_path(interval).await {
                break;
            }
        }
        log::info!("[RC] 被控推流已停止");
        // 先比对 id 再清槽位——新会话建立时会直接覆盖 inbound_send，不清不会漏，
        // 但不比对会让旧任务清掉新会话的发送半流。
        if self.svc.session_id_is(&self.my_id) {
            *self.svc.inbound_send.lock().await = None;
        }
    }
}

/// 被控端处理一条输入（R2）。UIPI / 只看档必须报错不静默。
pub(super) async fn handle_inbound_input(
    svc: &Arc<RcService>,
    peer: &str,
    ev: InputEvent,
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
) {
    let cap = match svc.session_capability() {
        Some(c) => c,
        None => return,
    };

    match &ev {
        InputEvent::ClipboardPush { text } => {
            if assert_control_allowed(cap).is_err() {
                return;
            }
            if let Err(e) = set_clipboard_text(text) {
                log::warn!("[RC] 写入被控剪贴板失败：{e}");
            }
            return;
        }
        InputEvent::ClipboardPull => {
            if assert_control_allowed(cap).is_err() {
                return;
            }
            match get_clipboard_text() {
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
                        let _ = write_frame(&mut guard, &b).await;
                    }
                }
                Err(e) => {
                    log::warn!("[RC] 读被控剪贴板失败：{e}");
                    let msg =
                        serde_json::json!({ "t": "clip_err", "error": format!("读剪贴板失败：{e}") });
                    if let Ok(b) = serde_json::to_vec(&msg) {
                        let mut guard = send.lock().await;
                        let _ = write_frame(&mut guard, &b).await;
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
        InputEvent::NetHint { rtt_ms } => {
            let scale = svc.set_peer_rtt(*rtt_ms);
            log::debug!("[RC] 对端 RTT {rtt_ms}ms → 码率 {scale}%");
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

    if assert_control_allowed(cap).is_err() {
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
                Ok((x, y, w, h)) => ScreenRegion { x, y, w, h },
                Err(_) => ScreenRegion::virtual_screen(),
            }
        } else if opts.virtual_screen {
            ScreenRegion::virtual_screen()
        } else {
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
                };
                let (w, h) =
                    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
                ScreenRegion {
                    x: 0,
                    y: 0,
                    w: w.max(1),
                    h: h.max(1),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                ScreenRegion::virtual_screen()
            }
        }
    };
    let r = inject(&ev, &region);
    if !r.ok {
        log::warn!("[RC] 键鼠注入失败（{peer}）：{}", r.error);
        // P1：UIPI 等失败要让发起端看见，不能只写日志
        let msg = serde_json::json!({ "t": "inject_err", "error": r.error });
        if let Ok(b) = serde_json::to_vec(&msg) {
            let mut guard = send.lock().await;
            let _ = write_frame(&mut guard, &b).await;
        }
        svc.set_inject_err(r.error.clone());
    }
}

/// 主屏逻辑尺寸（硬编打开用）。encode_bgra 在分辨率变化时会按新尺寸重开。
#[cfg(target_os = "windows")]
fn primary_screen_size() -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    (w.max(64) as u32, h.max(64) as u32)
}
