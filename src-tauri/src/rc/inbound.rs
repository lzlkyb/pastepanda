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
//! 🔴 推流节奏（2026-09-19 重做）：旧实现「干完活再睡 interval」，每帧周期 =
//! 档位间隔 + 抓帧编码耗时，拖窗口时全帧编码最重，实际掉到 3~5fps。现在：
//! - **固定节奏**：下一帧锚在 `frame_start + interval`，编码耗时不再叠加；
//! - **输入驱动提帧**：收到键鼠事件 `notify_waiters` 立刻醒过来抓一帧
//!   （`input_boost`），静止时保持慢节奏，拖动时逼近 BOOST_MIN_GAP 上限；
//! - **硬编覆盖全范围**：主屏 / 指定单屏 / 虚拟屏（多输出拼接）都走
//!   DXGI + H.264（`DxgiPool`），JPEG 只做编码器打不开或单帧失败时的兜底。
//!
//! ⚠️ 本模块的 async 方法一律取 `&mut self` 而不是 `&self`。不是随手写法：
//! async fn 的 future 会把参数（含 `&self`）持有到 future 结束，而
//! `tauri::async_runtime::spawn` 要求 `Send`——`&InboundVideo` 需要
//! `InboundVideo: Sync`（`DxgiPool` 里面是 `NonNull<c_void>`，不是），
//! `&mut InboundVideo` 只需要 `Send`（owned 的 `DxgiPool` 是）。改回
//! `&self` 会在 net.rs 的 spawn 处报「future cannot be sent」。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::input::{
    assert_control_allowed, current_cursor_shape, get_clipboard_text, inject, set_clipboard_text,
};
use super::input::{InputEvent, ScreenRegion};
use super::encode_h264::VideoCodec;
use super::protocol::{RcFrame, SessionPhase};
use super::service::{RcService, CLIPBOARD_MAX_JSON_BYTES};
use crate::sync::transport::{read_frame, write_frame};

/// 输入提帧的最小帧间隔：取 min(档位间隔, 33ms)（普通档拖动上限 30fps），
/// fps60 档 16ms → 上限 60fps、fps120 档 8ms → 上限 120fps。
/// 下限跟随档位间隔（提帧再快也不会超过档位本身）。
const BOOST_GAP_MAX_MS: u64 = 33;
const BOOST_GAP_MIN_MS: u64 = 16;

/// 被控端推流任务。
pub(super) struct InboundVideo {
    svc: Arc<RcService>,
    peer: String,
    /// 任务启动时的会话 id；收口只认它。
    my_id: String,
    /// 输入与画面共用的发送半流（对端收到的一切都从这里出去）。
    send: Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
    enc: Arc<std::sync::Mutex<super::video::EncoderState>>,
    /// 本会话连接句柄：数据报读取（鼠标低延迟通道）与 QUIC stats 采样都要用。
    conn: iroh::endpoint::Connection,
    #[cfg(target_os = "windows")]
    dxgi: super::dxgi::DxgiPool,
    /// R4 硬编会话；None = 不走硬编（配置 jpeg / 打不开）。
    #[cfg(target_os = "windows")]
    h264: Option<super::encode_h264::H264SessionEncoder>,
    /// P2-9：硬编连续失败计数。每次成功清零；连续 60 帧（~4s@15fps）失败
    /// 说明编码器环境坏了（驱动卸载 / MFT 损坏），置 `h264 = None` 熔断——
    /// 否则每帧都走「重开编码器 → 失败 → 回 JPEG」，重开本身每帧烧几百 ms。
    #[cfg(target_os = "windows")]
    enc_fail_streak: u32,
    /// P1：GPU 零拷贝路径已判定不可用（连续失败），本会话不再尝试。
    #[cfg(target_os = "windows")]
    gpu_disabled: bool,
    /// P2-1：视频数据报发送端（帧序号 + 分片 + XOR FEC）。
    #[cfg(target_os = "windows")]
    dgram: super::vid_dgram::VidDgramSender,
    /// 对端是否支持视频数据报（Request 帧能力位）。false = 旧版发起端：
    /// 它没有视频数据报读取任务，P 帧必须继续走可靠流，否则画面退化成
    /// 每秒一张关键帧的幻灯片。
    peer_dgram: bool,
    /// 输入提帧信号：键鼠事件到达时 `notify_waiters`，推流循环提前醒。
    input_boost: Arc<tokio::sync::Notify>,
    /// 上一帧抓取起点（提帧限速用）。
    last_frame_at: tokio::time::Instant,
    /// 对端解码断链 → 请求下一帧强制 IDR（P0-2 弱网自愈）。
    force_key: Arc<AtomicBool>,
    /// 最近一次发出的光标形状（变化才发）。
    last_cursor: Option<&'static str>,
    /// P1-7 自适应降频：档位间隔放大倍数（1~4）。编码持续跑不满档位间隔时翻倍。
    pace_scale: u32,
    /// 单圈工作量（抓帧+编码+发送）的指数平滑，ms。
    work_ema_ms: u64,
    /// Q8：**动帧**字节数 EMA——静止判定的稳定基线（静止时 P 帧几乎全是跳块，
    /// 极小）。只对判为「在动」的帧更新，静止期间不衰减。
    motion_ema_bytes: u64,
    /// Q8：画面进入静止的时刻（None = 非静止）。
    static_since: Option<std::time::Instant>,
    /// Q8：本轮静止是否已做过 IDR 精修（画面再动才重新武装）。
    static_refined: bool,
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

/// [`motion_verdict`] 的判定结果，驱动 Q8 静止精修状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MotionVerdict {
    /// 关键帧：**不参与运动判定**。自然 GOP 的 IDR 是节拍产物，精修强制的
    /// IDR 是本状态机自己的输出——把它们当成「画面动了」的话，精修 IDR
    /// 会清掉 `static_refined` 重新武装，静止画面变成每 ~330ms 一个 IDR 的
    /// 死循环（2026-09-19 审查发现的 P1）；顺带也避免把 500KB 量级的 IDR
    /// 字节混进动帧基准。基准未建立（ema=0）时首个动帧负责建立。
    Ignore,
    /// 动帧：更新字节基准、清静止计时、重新武装精修。
    Moving,
    /// 静帧：挂静止计时，超时强制一次 IDR。
    Static,
}

/// 一帧编码输出的运动判定（纯函数，可单测）。
///
/// 「动了」的判据：帧字节 ≥ 动帧基准的 1/6——静止画面的跳块 P 帧只有
/// 基准的零头。基准未建立（0）时任何非关键帧都算动（负责建立基准）。
pub(crate) fn motion_verdict(is_key: bool, motion_ema_bytes: u64, frame_bytes: u64) -> MotionVerdict {
    if is_key {
        MotionVerdict::Ignore
    } else if motion_ema_bytes == 0 || frame_bytes >= motion_ema_bytes / 6 {
        MotionVerdict::Moving
    } else {
        MotionVerdict::Static
    }
}

impl InboundVideo {
    /// 会话存在、是入站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(super) fn try_new(
        svc: Arc<RcService>,
        peer: &str,
        send: iroh::endpoint::SendStream,
        conn: iroh::endpoint::Connection,
        peer_dgram: bool,
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
        let enc = Arc::new(std::sync::Mutex::new(
            super::video::EncoderState::with_profile(profile, virt),
        ));
        // R6：主屏 / 指定单屏 / 虚拟屏都优先 DXGI + H.264；打不开回退 JPEG
        #[cfg(target_os = "windows")]
        let h264 = Self::open_h264(&svc, virt);
        Some(Self {
            svc,
            peer: peer.to_string(),
            my_id,
            send,
            enc,
            #[cfg(target_os = "windows")]
            dxgi: super::dxgi::DxgiPool::new(),
            #[cfg(target_os = "windows")]
            h264,
            #[cfg(target_os = "windows")]
            enc_fail_streak: 0,
            #[cfg(target_os = "windows")]
            gpu_disabled: false,
            #[cfg(target_os = "windows")]
            dgram: super::vid_dgram::VidDgramSender::new(),
            peer_dgram,
            conn,
            input_boost: Arc::new(tokio::sync::Notify::new()),
            last_frame_at: tokio::time::Instant::now(),
            force_key: Arc::new(AtomicBool::new(false)),
            last_cursor: None,
            pace_scale: 1,
            work_ema_ms: 0,
            motion_ema_bytes: 0,
            static_since: None,
            static_refined: false,
        })
    }

    /// R6 硬编会话：配置强制 JPEG 时不开；打不开也回 None（走 JPEG）。
    /// Q3：配置 `hevc` 时按 HEVC 打开（打不开 SessionEncoder 会话内自动回落
    /// H.264，不再整个退 JPEG）。打开尺寸跟**当前抓取范围**的物理分辨率走
    /// （会话中换范围时 `encode_bgra` 检测到尺寸变化会自己重开）。
    /// 时间戳统一按 30fps 步进：输入提帧的上限也是 30fps（BOOST_MIN_GAP），
    /// 保证时间戳单调不倒退。
    #[cfg(target_os = "windows")]
    fn open_h264(
        svc: &Arc<RcService>,
        virt: bool,
    ) -> Option<super::encode_h264::H264SessionEncoder> {
        // Q3：编码标准统一从会话参数快照取——`reset_stream_opts_from_cfg` 已把
        // 本机配置（rc_codec）解析进去，与会话中 SetCodec 的切换同一条通路；
        // uhd60 等自带 HEVC 偏好的档位也在这里生效。
        let opts = svc.stream_opts_snapshot();
        if opts.force_jpeg() {
            return None;
        }
        let codec = if opts.profile.hevc
            || matches!(opts.codec, super::stream_cfg::StreamCodec::Hevc)
        {
            VideoCodec::Hevc
        } else {
            VideoCodec::H264
        };
        let (pw, ph) = if virt {
            let (sx, sy, sw, sh) = virtual_screen_size();
            let _ = (sx, sy);
            (((sw.max(64) as u32) + 1) & !1, ((sh.max(64) as u32) + 1) & !1)
        } else {
            primary_screen_size()
        };
        // fps120/fps60/uhd60 档按 120/60/60fps 出时间戳；其余档位提帧上限 30fps
        let fps = if svc.encode_profile().interval_ms <= 10 {
            120
        } else if svc.encode_profile().interval_ms <= 20 {
            60
        } else {
            30
        };
        let enc = super::encode_h264::H264SessionEncoder::try_open(codec, pw, ph, fps);
        if enc.available() {
            log::info!(
                "[RC] {} 硬编已启用 @ {pw}x{ph} {fps}fps（范围：{}）",
                codec.as_str().to_uppercase(),
                if virt { "虚拟屏" } else { "主屏" }
            );
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

    /// P0-3：数据报读取任务——发起端的鼠标移动走 QUIC 不可靠数据报
    /// （绝对坐标 latest-wins，丢包被下一帧校正；按键/滚轮仍在可靠流）。
    /// 视频大帧把可靠流堵住时，鼠标依然每一拍都进得来。
    fn spawn_datagram_reader(&self) {
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let send = self.send.clone();
        let boost = self.input_boost.clone();
        let conn = self.conn.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if !svc.session_is(SessionPhase::InboundActive, &peer) {
                    break;
                }
                // P0-1 B5：`read_datagram` 没有超时语义——会话结束后若连接还活着
                //（对端没关 / QUIC 空闲超时未到），这个任务会一直挂着 conn 克隆。
                // 用 500ms 一拍的会话检查把退出变成有界的。
                let bytes = tokio::select! {
                    r = conn.read_datagram() => match r {
                        Ok(b) => b,
                        Err(_) => break,
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => continue,
                };
                if let Ok(ev) = serde_json::from_slice::<InputEvent>(&bytes) {
                    svc.touch_activity();
                    // 数据报只承载鼠标移动；提帧与可靠流同款语义
                    boost.notify_waiters();
                    handle_inbound_input(&svc, &peer, ev, &send).await;
                }
            }
            // 数据报通道断开不单独收口会话：输入半流的断开兜底（连接级）
        });
    }

    /// G3：音频任务。对端申请了系统声音时启动：采集 worker（独立线程，
    /// WASAPI 环回 + 收件箱 AAC）→ 通道 → 本任务把包写进**专用 QUIC 单向流**
    ///（与视频可靠流分属不同流，互不队头阻塞）。会话中静音/恢复由 wanted
    /// 标志驱动：停时关采集、关流；恢复时 worker 重发 Cfg → 开新流，
    /// 发起端的 accept 循环天然承接「一条流结束了、又来一条」。
    #[cfg(target_os = "windows")]
    fn spawn_audio_task(&self) {
        use std::sync::atomic::AtomicBool;
        if !self.svc.audio_peer_wants() {
            return;
        }
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let conn = self.conn.clone();
        tauri::async_runtime::spawn(async move {
            let (tx, mut rx) =
                tokio::sync::mpsc::unbounded_channel::<super::audio::AudioOut>();
            let mut worker: Option<super::audio::AudioWorker> = None;
            let wanted_flag = Arc::new(AtomicBool::new(false));
            let mut stream: Option<iroh::endpoint::SendStream> = None;
            // 当前流头写过的 Cfg（P2-7）：设备切换/编码器重开会送来新 Cfg——
            // 格式变了必须换新流（对端按流头重建解码器）；裸包流会被对端
            // 判成「非音频流」整条丢弃。
            let mut stream_cfg: Option<super::audio::AudioCfg> = None;
            loop {
                if !svc.session_is(SessionPhase::InboundActive, &peer) {
                    break;
                }
                let wanted = svc.audio_wanted();
                wanted_flag.store(wanted, std::sync::atomic::Ordering::SeqCst);
                if !wanted {
                    // 停采集 + 关流；对端读到 EOF 回 accept 循环等新流
                    if let Some(w) = worker.as_mut() {
                        w.stop();
                    }
                    worker = None;
                    stream = None;
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    continue;
                }
                if worker.is_none() {
                    worker =
                        Some(super::audio::AudioWorker::start(wanted_flag.clone(), tx.clone()));
                }
                let msg = tokio::select! {
                    m = rx.recv() => match m {
                        Some(m) => m,
                        None => break,
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => continue,
                };
                match msg {
                    super::audio::AudioOut::Cfg(cfg) => {
                        // 没流 / 格式变了（设备切换、编码器重开）→ 开新流并先写流头。
                        // 同格式重复的 Cfg 忽略（头已写过，别把头塞进包序列中间）。
                        if stream.is_none() || stream_cfg.as_ref() != Some(&cfg) {
                            // 显式弃旧流（drop 让对端读到 EOF 回 accept 循环等新流）
                            drop(stream.take());
                            stream = conn.open_uni().await.ok();
                            if let Some(s) = stream.as_mut() {
                                let header = super::audio::encode_stream_header(&cfg);
                                if s.write_all(&header).await.is_err() {
                                    stream = None;
                                    stream_cfg = None;
                                } else {
                                    stream_cfg = Some(cfg);
                                }
                            }
                        }
                    }
                    super::audio::AudioOut::Pkt { pts_ms, data } => {
                        if stream.is_none() {
                            // P2-7：重建流必须先补流头——原先只在 Cfg 消息时写头，
                            // 头那次 write 失败后，后续裸包流会被对端判成
                            // 「非音频流」整条丢弃，本场会话永久无声。
                            // 没有 stream_cfg 时只能丢包（还没拿到过格式）。
                            if let Some(cfg) = stream_cfg.clone() {
                                stream = conn.open_uni().await.ok();
                                if let Some(s) = stream.as_mut() {
                                    let header = super::audio::encode_stream_header(&cfg);
                                    if s.write_all(&header).await.is_err() {
                                        stream = None;
                                    }
                                }
                            }
                        }
                        if let Some(s) = stream.as_mut() {
                            let pkt = super::audio::encode_packet(pts_ms, &data);
                            if s.write_all(&pkt).await.is_err() {
                                stream = None;
                            }
                        }
                    }
                }
            }
            if let Some(w) = worker.as_ref() {
                w.stop();
            }
        });
    }

    /// P0-4：QUIC stats 采样——被控端**本端**的 RTT / 丢包率，每 500ms 喂给码控。
    /// 丢包按窗口增量算（‰）并做指数平滑；窗口内没有新包就不更新（保留旧值）。
    fn spawn_stats_sampler(&self) {
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let conn = self.conn.clone();
        tauri::async_runtime::spawn(async move {
            let mut prev: Option<(u64, u64)> = None;
            let mut ema_permille: u64 = 0;
            let mut has_ema = false;
            loop {
                if !svc.session_is(SessionPhase::InboundActive, &peer) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let st = conn.stats();
                // iroh 的 ConnectionStats 是连接级扁平计数：丢包分母用发出的
                // UDP 包数（udp_tx.datagrams），RTT 走 conn.rtt(初始路径)
                let (lost, sent) = (st.lost_packets, st.udp_tx.datagrams);
                let sample: i64 = match prev {
                    Some((pl, ps)) if sent > ps => {
                        let d_sent = sent - ps;
                        let d_lost = lost.saturating_sub(pl);
                        let pm = d_lost * 1000 / d_sent.max(1);
                        // 指数平滑：单窗口抖动别直接打到码控上
                        let next = if has_ema {
                            (ema_permille * 7 + pm * 3) / 10
                        } else {
                            pm
                        };
                        has_ema = true;
                        ema_permille = next;
                        ema_permille as i64
                    }
                    _ => -1,
                };
                prev = Some((lost, sent));
                let rtt = conn
                    .rtt(iroh::endpoint::PathId::ZERO)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                svc.note_stream_health(rtt, sample);
            }
        });
    }

    /// P1-6：光标形状变化时发一条控制帧（每圈比对一次，变化才发）。
    async fn maybe_send_cursor(&mut self) {
        let shape = current_cursor_shape();
        let s = shape.as_str();
        if self.last_cursor == Some(s) {
            return;
        }
        self.last_cursor = Some(s);
        let msg = serde_json::json!({ "t": "cursor", "s": s });
        if let Ok(b) = serde_json::to_vec(&msg) {
            let mut guard = self.send.lock().await;
            let _ = write_frame(&mut guard, &b).await;
        }
    }    /// 输入读取任务：End 帧收口；其余解成 InputEvent，心跳回 pong，其它交
    /// `handle_inbound_input`。半流断开同样收口（对端崩溃 / 网络断）。
    ///
    /// 🔴 任何键鼠事件都先 `notify_waiters` 提帧：让推流循环立刻醒过来抓一帧，
    /// 拖动窗口时画面跟着输入走，而不是等下一档位间隔。
    fn spawn_input_reader(&self, mut recv: iroh::endpoint::RecvStream) {
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let send = self.send.clone();
        let my_id = self.my_id.clone();
        let boost = self.input_boost.clone();
        let force_key = self.force_key.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if !svc.session_is(SessionPhase::InboundActive, &peer) {
                    break;
                }
                // P0-1 B5：与数据报读取同款有界退出——read_frame 无超时，
                // 连接悬着时这个任务会陪着挂到 QUIC 空闲超时。
                let bytes = tokio::select! {
                    r = read_frame(&mut recv) => match r {
                        Ok(b) => b,
                        Err(_) => break,
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => continue,
                };
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
                        // 回 pong，发起端测 RTT；hts = 本机时钟（epoch ms），
                        // 发起端据此算两机时钟偏差——「画面延迟」显示才有意义
                        //（P0-1 A3：跨机时钟偏差会污染帧龄）
                        let msg = serde_json::json!({
                            "t": "pong",
                            "ts": ts,
                            "hts": super::service::now_ms(),
                        });
                        if let Ok(b) = serde_json::to_vec(&msg) {
                            let mut guard = send.lock().await;
                            let _ = write_frame(&mut guard, &b).await;
                        }
                    } else if matches!(ev, InputEvent::RequestKey) {
                        // P0-2：解码断链请求关键帧——只立标志，推流循环
                        // 下一帧前对编码器 ForceKeyFrame
                        force_key.store(true, Ordering::SeqCst);
                    } else {
                        // 输入提帧：注入前就唤醒（DXGI 的 AcquireNextFrame
                        // 等待窗口正好覆盖注入生效所需的几毫秒）
                        boost.notify_waiters();
                        handle_inbound_input(&svc, &peer, ev, &send).await;
                    }
                }
            }
            // 输入半流断了：会话也要收口（对端崩溃 / 网络断）
            svc.force_end_if_session(&my_id, "控制通道断开").await;
        });
    }

    /// R6 硬编路径：主屏 / 指定单屏 / 虚拟屏都走 DXGI + H.264；仅强制 JPEG 时回退。
    /// P1：fps120 档（interval ≤10ms）+ 单输出场景走 D3D11 零拷贝；
    /// 其余（多屏拼接 / 低档位 / GPU 路径不可用）走 CPU 管线，失败回 JPEG。
    async fn try_hardware_path(&mut self, opts: &super::stream_cfg::StreamOpts) -> Step {
        #[cfg(target_os = "windows")]
        {
            let Some(henc) = self.h264.as_mut() else {
                return Step::FallThrough;
            };
            if !henc.available() || opts.force_jpeg() {
                return Step::FallThrough;
            }
            // Q3/Q4：编码标准跟会话参数走——显式 SetCodec（hevc/h264）或档位
            // 自带 HEVC 偏好（uhd60）都会触发编码器按需重开；HEVC 连续打不开
            // 时 SessionEncoder 自己回落 H.264。
            let want_hevc = opts.profile.hevc
                || matches!(opts.codec, super::stream_cfg::StreamCodec::Hevc);
            henc.set_codec(if want_hevc {
                VideoCodec::Hevc
            } else {
                VideoCodec::H264
            });
            // R5.B2：按对端 RTT 缩码率（重开延迟到下一次编码时执行）
            let scale = self.svc.bitrate_scale();
            henc.apply_bitrate_scale(scale);
            // P0-2：对端解码断链 → 下一帧强制 IDR（设不中就等自然 GOP）
            if self.force_key.swap(false, Ordering::SeqCst) {
                let ok = henc.force_key();
                log::debug!("[RC] 对端请求关键帧：{}", if ok { "已强制" } else { "编码器不支持" });
            }
            // 时间戳 fps 跟档位走（120/60/30），编码器按需重开
            let want_fps = if opts.profile.interval_ms <= 10 {
                120
            } else if opts.profile.interval_ms <= 20 {
                60
            } else {
                30
            };
            henc.set_fps(want_fps);
            // P1/G5 零拷贝门控：档位要（fps120 / uhd60）+ 单输出 + GPU 路径没被判死。
            // 判据集中在 `EncodeProfile::wants_zero_copy`（有单测）——写错不崩、
            // 只会静默跑 CPU 管线。
            let want_gpu = opts.profile.wants_zero_copy(opts.virtual_screen, self.gpu_disabled);
            if want_gpu {
                // P0-2 延迟分段：抓帧耗时单独记
                let cap_t0 = std::time::Instant::now();
                let grabbed = self.dxgi.grab_gpu(opts.virtual_screen, opts.monitor);
                let cap_ms = cap_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                match grabbed {
                    Err(e) if e.starts_with("[gpu_disabled]") => {
                        self.gpu_disabled = true;
                    }
                    Err(e) => {
                        log::debug!("[RC] GPU 抓帧失败，本帧走 CPU：{e}");
                    }
                    Ok(None) => return Step::Sleep,
                    Ok(Some(g)) => {
                        // 采集时刻在 grab 之后取：编码/发送耗时不算进「画面链路延迟」
                        let ts = super::service::now_ms();
                        if let (Some(dev), Some(ctx)) =
                            (self.dxgi.d3d_device(), self.dxgi.d3d_ctx())
                        {
                            let enc_t0 = std::time::Instant::now();
                            let encoded =
                                henc.encode_gpu(&dev, &ctx, &g.tex, g.width, g.height);
                            let enc_ms =
                                enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                            match encoded {
                                Ok(pkts) => {
                                    return self
                                        .send_h264_pkts(pkts, ts, cap_ms, enc_ms)
                                        .await;
                                }
                                Err(e) if e.starts_with("[gpu_disabled]") => {
                                    self.gpu_disabled = true;
                                }
                                Err(e) => {
                                    log::debug!("[RC] GPU 编码失败，本帧走 CPU：{e}");
                                }
                            }
                        }
                    }
                }
            }
            // ---- CPU 管线（多屏拼接 / 低档位 / GPU 路径不可用的兜底）----
            // P0-2 延迟分段：抓帧耗时单独记（HUD 分「慢在抓/慢在编/慢在网络」）
            let cap_t0 = std::time::Instant::now();
            let grabbed = self.dxgi.grab(opts.virtual_screen, opts.monitor);
            let cap_ms = cap_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
            match grabbed {
                Ok(Some((w, h, bgra))) => {
                    if w % 2 == 1 || h % 2 == 1 {
                        // NV12/H.264 要求偶数尺寸；奇数（理论上不该出现）本帧回 JPEG
                        return Step::FallThrough;
                    }
                    // 采集时刻就在 grab 之后取：编码/发送耗时不算进「画面链路延迟」
                    let ts = super::service::now_ms();
                    let enc_t0 = std::time::Instant::now();
                    let encoded = henc.encode_bgra(&bgra, w, h);
                    let enc_ms = enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                    match encoded {
                        Ok(pkts) => {
                            self.enc_fail_streak = 0;
                            self.send_h264_pkts(pkts, ts, cap_ms, enc_ms).await
                        }
                        Err(e) => {
                            // P2-9：连续失败熔断——每帧重开编码器的代价比「画质
                            // 降级到 JPEG」高得多，烧到会话结束更不划算。
                            self.enc_fail_streak = self.enc_fail_streak.saturating_add(1);
                            if self.enc_fail_streak >= 60 {
                                log::error!(
                                    "[RC] 硬编连续 {} 帧失败，本会话熔断硬编改走 JPEG：{e}",
                                    self.enc_fail_streak
                                );
                                self.h264 = None;
                            } else {
                                log::debug!("[RC] 视频编码失败（第 {} 帧），本帧回退 JPEG：{e}", self.enc_fail_streak);
                            }
                            Step::FallThrough
                        }
                    }
                }
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

    /// 推送 H.264 包（CPU/GPU 两路共用）。
    ///
    /// P2-1 传输策略：**P 帧走 QUIC 数据报 + 帧内 XOR FEC**（不可靠但无队头
    /// 阻塞，丢片由 FEC 补、补不回由 corrupt→request_key 自愈）；**关键帧走
    /// 可靠流**并带帧序号（对端据此重置数据报重组器）。数据报缓冲挤满时：
    /// 关键帧回退流（有 seq 锚，安全），P 帧直接弃帧（下一帧在接收端成洞 →
    /// corrupt 等关键帧——绝不能用流补发，会造成双份同序号帧）。
    #[cfg(target_os = "windows")]
    async fn send_h264_pkts(
        &mut self,
        pkts: Vec<super::encode_h264::H264Packet>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
    ) -> Step {
        if pkts.is_empty() {
            return Step::Sleep;
        }
        // Q3：编码标准取自编码器本体（HEVC 打不开自动回落 H.264 时，同帧起即换）
        let hevc = self
            .h264
            .as_ref()
            .is_some_and(|e| e.codec() == VideoCodec::Hevc);
        // Q8 文本清晰：H264/HEVC 是 CBR 码控，静止画面的 P 帧几乎全是跳块，
        // 滚动文档落下的糊字不会被后续 P 帧修好（JPEG 路径有 300ms q95 精修，
        // 这条路径此前没有任何回补）。静止 >REFINE_AFTER_MS 时强制一个 IDR：
        // 整帧按当前码率重新编码，静止文本立刻变脆。静止判定用「只对动帧
        // 更新的字节基准」——EMA 连静止帧一起算会在高帧率下几十毫秒内收敛，
        // 阈值失真；动帧基准在静止期间保持稳定，静止多久都判得准。
        // 每轮静止只精修一次（画面再动才重新武装），不会周期性打爆码率。
        //
        // 🔴 判定交给纯函数 [`motion_verdict`]：这里曾是 `is_key || …`——
        //   精修强制出的 IDR 自己就被当成了「画面动了」，把 static_refined
        //   清掉重新武装，静止画面变成每 ~330ms 一个 IDR 的死循环。
        //   关键帧（无论自然 GOP 还是精修产物）不参与运动判定，见该函数。
        let frame_bytes: u64 = pkts.iter().map(|p| p.data.len() as u64).sum();
        let is_key = pkts.iter().any(|p| p.key);
        match motion_verdict(is_key, self.motion_ema_bytes, frame_bytes) {
            MotionVerdict::Ignore => {}
            MotionVerdict::Moving => {
                self.motion_ema_bytes = if self.motion_ema_bytes == 0 {
                    frame_bytes.max(1)
                } else {
                    (self.motion_ema_bytes * 7 + frame_bytes) / 8
                };
                self.static_since = None;
                self.static_refined = false;
            }
            MotionVerdict::Static => {
                let since = *self.static_since.get_or_insert(std::time::Instant::now());
                if !self.static_refined
                    && since.elapsed().as_millis() as i64 > super::video::REFINE_AFTER_MS
                {
                    if self.h264.as_ref().is_some_and(|e| e.force_key()) {
                        log::debug!("[RC] 画面静止，下一帧 IDR 精修（文本清晰）");
                    }
                    // 无论编码器支不支持都只试一次，别每圈都敲
                    self.static_refined = true;
                }
            }
        }
        for p in pkts {
            let sq = self.dgram.take_seq();
            // 关键帧走可靠流（重组锚）；对端是旧版发起端时 P 帧也走可靠流
            //（能力位缺省 = 它读不了视频数据报，见 `peer_dgram` 字段注释）。
            if p.key || !self.peer_dgram {
                let mut guard = self.send.lock().await;
                if super::video::write_h264(
                    &mut guard, &p.data, p.key, p.width, p.height, ts, cap_ms, enc_ms, sq, hevc,
                )
                .await
                .is_err()
                {
                    drop(guard);
                    self.svc
                        .force_end_if_session(&self.my_id, "H.264 推送失败")
                        .await;
                    return Step::End;
                }
                continue;
            }
            match self.dgram.send_frame(
                &self.conn,
                sq,
                &p.data,
                false,
                ts,
                cap_ms,
                enc_ms,
                p.width,
                p.height,
                hevc,
            ) {
                Ok(()) => {}
                Err(super::vid_dgram::SendErr::Busy) => {
                    // 数据报缓冲满 = 拥塞。弃帧：接收端成洞 → corrupt → 要关键帧。
                    log::debug!("[RC] 数据报缓冲满，弃 P 帧 #{sq}（走自愈）");
                }
                Err(super::vid_dgram::SendErr::Dropped(e)) => {
                    log::debug!("[RC] P 帧分片发送中断（{e}）——接收端将走自愈");
                }
            }
        }
        Step::Sleep
    }

    /// JPEG 路径：阻塞截帧+编码丢进 spawn_blocking，写脏矩形元数据 + JPEG。
    /// 写失败 = 对端/链路没了，收口退出。节奏（sleep）由 run() 的固定节拍管，
    /// 这里不再自己睡——旧实现「干完活再睡 interval」是拖动卡顿的元凶之一。
    async fn jpeg_path(&mut self) -> Step {
        let enc = self.enc.clone();
        let result = tokio::task::spawn_blocking(move || {
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
                // P2-10：JPEG 帧也带采集时间戳（H.264 走 meta JSON）；
                // P0-2：顺带采集/编码耗时，发起端 HUD 分段显示
                if let Err(e) = super::video::write_vts_meta(
                    &mut guard,
                    enc_out.frame.at_ms,
                    enc_out.frame.cap_ms,
                    enc_out.frame.enc_ms,
                )
                .await
                {
                    log::info!("[RC] 时间戳元数据写失败：{e}");
                    drop(guard);
                    self.svc
                        .force_end_if_session(&self.my_id, "画面推送失败")
                        .await;
                    return Step::End;
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
                drop(guard);
                // 2A 自动档：把这一帧的字节数喂给迟滞判据。换档不改 opts 之外的任何
                // 状态——run() 下一圈的 stream_opts_snapshot 比对会自己套用新 profile。
                // ❗ 高保真回补帧不计入：它是一次性画质投资，喂进去会把正常档压低。
                if !enc_out.refine {
                    self.svc.auto_note_frame(enc_out.frame.jpeg.len());
                }
            }
            Ok(Err(e)) => {
                log::debug!("[RC] 截帧失败：{e}");
            }
            Err(e) => {
                log::warn!("[RC] 截帧任务失败：{e}");
            }
        }
        Step::Sleep
    }

    pub(super) async fn run(mut self, recv: iroh::endpoint::RecvStream) {
        // 被控端结束会话时要用这条半流发 End
        self.register_send_slot().await;
        self.spawn_input_reader(recv);
        // P0-3 / P0-4：鼠标数据报通道 + 本端链路状况采样
        self.spawn_datagram_reader();
        self.spawn_stats_sampler();
        // G3：对端申请了系统声音 → 音频采集 + 专用流
        self.spawn_audio_task();
        // 会话刚建立：立刻可推流，等首个心跳
        self.svc.touch_activity();
        // P1-6：会话建立先报一次当前光标形状
        self.maybe_send_cursor().await;
        // P1：把画面能力（fps120 可用性）报给对端，UI 才能诚实出档
        send_caps_frame(&self.svc, &self.send).await;
        // G3-B：音频状态也报一次初值。被控者的「不发送声音」是跨会话保持的，
        // 不报初值的话发起端这一场只能看到空/上次残留，误判成「对方没静音」。
        self.svc.emit_host_audio(None).await;
        // 固定节奏锚点：下一帧的抓取时刻。每圈干完活后重设为
        // frame_start + interval —— 编码耗时不再叠加进帧间隔。
        let mut next_tick = tokio::time::Instant::now();
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
            // 等待：到点（固定节奏）或 输入提帧（拖动跟手）。
            // notify_waiters 不存许可：错过一次唤醒最多等下一档位间隔，无自旋风险。
            {
                let notified = self.input_boost.notified();
                tokio::select! {
                    _ = tokio::time::sleep_until(next_tick) => {}
                    _ = notified => {}
                }
            }
            // 提帧限速：min(档位间隔, 33ms)，下限跟随档位（fps120=8ms、fps60=16ms，
            // 其余 16ms）——普通档拖动上限 30fps，fps60 档 60fps，fps120 档 120fps
            let opts = self.svc.stream_opts_snapshot();
            // D6b：fps120 请求落到没有零拷贝路径的场景（多屏拼接 / GPU 已判死）时，
            // 不能让 CPU 管线按 8ms 硬跑——节奏降到 16ms（fps60 体感）。UI 门控
            // 只挡正常路径，挡不住会话中途切范围/直连接口的请求。
            let mut interval = opts.profile.interval_ms;
            if interval <= 10 && (opts.virtual_screen || self.gpu_disabled) {
                interval = 16;
            }
            let boost_gap = {
                let g = interval.min(BOOST_GAP_MAX_MS).max(interval.min(BOOST_GAP_MIN_MS));
                std::time::Duration::from_millis(g)
            };
            let frame_start = {
                let now = tokio::time::Instant::now();
                let min_next = self.last_frame_at + boost_gap;
                if now < min_next {
                    tokio::time::sleep_until(min_next).await;
                    tokio::time::Instant::now()
                } else {
                    now
                }
            };
            self.last_frame_at = frame_start;

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
            // P1-6：每圈顺手比一次光标形状（GetCursorInfo 微秒级）
            self.maybe_send_cursor().await;

            let work_start = tokio::time::Instant::now();
            let ended = match self.try_hardware_path(&opts).await {
                // Sleep = 本圈已推完或屏幕无变化。jpeg_path 是一次全量 GDI 截屏 +
                // 差分：H264 会话里跑它就是每圈白烧 CPU（8ms 预算装不下，直接把
                // 固定节奏拖死），画面一动还会往 H264 流里插冗余 JPEG 帧、污染
                // 自动档判据与 HUD 分段。JPEG 只服务 FallThrough（编码器不可用/
                // 单帧失败）。2026-09-19 审查 R1：节奏重做时曾把这条回归掉。
                Step::Sleep => false,
                Step::End => true,
                Step::FallThrough => matches!(self.jpeg_path().await, Step::End),
            };
            if ended {
                break;
            }
            // P1-7 自适应降频：单圈工作量持续贴着当前间隔跑 → 放大间隔；
            // 富余出来再缩回。EMA 平滑 + 2x/4x 判据，避免来回抖。
            let work_ms = (tokio::time::Instant::now() - work_start).as_millis() as u64;
            self.work_ema_ms = if self.work_ema_ms == 0 {
                work_ms
            } else {
                (self.work_ema_ms * 7 + work_ms) / 8
            };
            let scaled = interval * self.pace_scale as u64;
            if scaled > 0 && self.work_ema_ms * 2 > scaled {
                if self.pace_scale < 4 {
                    self.pace_scale += 1;
                    log::info!("[RC] 编码跑不满档位间隔（EMA {}/{}ms），放大到 {}x",
                        self.work_ema_ms, scaled, self.pace_scale);
                }
            } else if self.pace_scale > 1 && self.work_ema_ms * 4 < scaled {
                self.pace_scale -= 1;
            }
            // 下一帧锚在「本帧开始 + 档位间隔×降频倍数」：固定节奏，不受编码耗时影响
            next_tick = frame_start + std::time::Duration::from_millis(scaled);
        }
        log::info!("[RC] 被控推流已停止");
        // 先比对 id 再清槽位——新会话建立时会直接覆盖 inbound_send，不清不会漏，
        // 但不比对会让旧任务清掉新会话的发送半流。
        if self.svc.session_id_is(&self.my_id) {
            *self.svc.inbound_send.lock().await = None;
        }
    }
}

/// P1：向发起端报告本机画面能力（fps120「高帧率+」可用性与主屏刷新率）。
/// 零拷贝门槛：硬件 D3D11-aware H.264 MFT + 单输出捕获范围 + 刷新 ≥100Hz，
/// 三者缺一就不许选——跑不到的档不卖。会话建立与范围变更时各发一次。
async fn send_caps_frame(
    svc: &Arc<RcService>,
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
) {
    #[cfg(target_os = "windows")]
    let caps = super::gpu::encode_caps();
    let opts = svc.stream_opts_snapshot();
    let single_out = !opts.virtual_screen;
    #[cfg(target_os = "windows")]
    let (fps120, hz) = {
        // M2：刷新率按**被抓的那块屏**算——抓指定单屏时，主屏的刷新率不代表它
        let hz = if single_out && opts.monitor >= 0 {
            super::gpu::refresh_hz_for_monitor(opts.monitor)
        } else {
            caps.refresh_hz
        };
        (caps.h264_gpu && single_out && hz >= 100, hz)
    };
    #[cfg(not(target_os = "windows"))]
    let (fps120, hz) = (false, 0u32);
    // Q3：HEVC 硬编可用性。旧版本对端忽略；uhd60 档的 UI 门控靠它。
    #[cfg(target_os = "windows")]
    let hevc = caps.hevc_hw;
    #[cfg(not(target_os = "windows"))]
    let hevc = false;
    // Q7：顺带报告在线显示器列表（几何信息齐全），发起端会话内出逐屏选项 +
    // 「下一屏」轮换按钮。旧版本对端会忽略这个字段，无兼容问题。
    #[cfg(target_os = "windows")]
    let monitors = crate::screenshot::list_monitors().unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let monitors: Vec<crate::screenshot::MonitorInfo> = Vec::new();
    let msg = serde_json::json!({
        "t": "caps",
        "fps120": fps120,
        "hz": hz,
        "hevc": hevc,
        "monitors": monitors,
    });
    if let Ok(b) = serde_json::to_vec(&msg) {
        let mut guard = send.lock().await;
        let _ = write_frame(&mut guard, &b).await;
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
                    let msg = serde_json::json!({ "t": "clip_err", "error": format!("读剪贴板失败：{e}") });
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
                // Q10：与 SetCaptureScope 同理——对端（含只看会话）改了本机推流
                // 档位，被控者不能只有 log；画质被调低画面变糊要能看见原因。
                svc.emit_stream_note("quality", quality);
            }
            return;
        }
        InputEvent::NetHint { rtt_ms } => {
            let scale = svc.set_peer_rtt(*rtt_ms);
            log::debug!("[RC] 对端 RTT {rtt_ms}ms → 码率 {scale}%");
            return;
        }
        InputEvent::SetBitratePct { pct } => {
            // Q5：发起端的码率倍率偏好。与 NetHint 一样是连续调整而非离散
            // 变更，不进 Q10 提示；被控端无感（画质档不变，只是编码目标变了）。
            if let Err(e) = svc.set_user_bitrate_pct(*pct) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端码率倍率：{pct}%");
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
                // P1：范围变了 → 单输出判定变了 → fps120 可用性跟着变，重报
                send_caps_frame(svc, send).await;
            }
            return;
        }
        InputEvent::SetCodec { codec } => {
            if let Err(e) = svc.set_stream_codec(codec) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求编码：{codec}");
                // Q10：编码切换同样要被控端可见（H.264 ↔ JPEG 观感差异明显）
                svc.emit_stream_note("codec", codec);
            }
            return;
        }
        // G3：发起端开关系统声音。不注入输入；被控端必须看得见——
        // 「我的声音正在被对方听」和「画面被切走」是同一级别的可见性。
        InputEvent::AudioOn { on } => {
            svc.set_audio_muted(!*on);
            // 与 quality/codec 同款分工：note 里传**原值**（on/off），中文文案归前端。
            // 传句子会让被控横幅的「不是 codec 就是画质」分支把它读成画质。
            svc.emit_stream_note("audio", if *on { "on" } else { "off" });
            log::info!("[RC] 对端{}系统声音", if *on { "开启" } else { "关闭" });
            return;
        }
        // G3-C：发起端要求静音 / 恢复**本机（被控端）主机扬声器**。
        //
        // 🔴 要求 Control —— 这动的是本机的**物理输出环境**（屋里人听不听得到），
        // 与「改画质」那类只影响发起端自己画面的指令不同档，和键鼠注入同级。
        // 「只看」会话拒绝，并且**明确回一条失败**，免得发起端的按钮点了没反应。
        InputEvent::SetHostMute { on } => {
            let err = if assert_control_allowed(cap).is_err() {
                Some("当前会话仅为「只看」，无法改对方主机声音".to_string())
            } else {
                match super::audio::spk_mute_set(*on) {
                    Ok(actual) => {
                        // 记「对端操作过且未撤销」——横幅据此摆提示与恢复入口。
                        svc.set_spk_muted_by_peer(actual);
                        // 本机前端的快照要跟着变，否则横幅提示与恢复按钮不会出现
                        // （这个分支不像命令层那样自带 emit）。
                        svc.notify.emit_changed();
                        log::info!("[RC] 对端{}本机扬声器", if actual { "静音了" } else { "恢复了" });
                        None
                    }
                    Err(e) => {
                        log::warn!("[RC] 切换本机扬声器静音失败：{e}");
                        Some(format!("切换主机扬声器失败：{e}"))
                    }
                }
            };
            // 回帧带**读回的真实值**（可能与我们请求的不同），发起端的按钮态以它为准。
            svc.emit_host_audio(err.as_deref()).await;
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

/// 虚拟屏几何（硬编初始打开用）。会话中换范围时 encode_bgra 按新尺寸重开。
#[cfg(target_os = "windows")]
fn virtual_screen_size() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}
