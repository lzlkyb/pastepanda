//! 被控端会话的**后台任务**与**画面能力上报**（2026-09-21 从 `inbound.rs` 拆出）。
//!
//! # 为什么单独一个文件
//!
//! `inbound.rs` 原本混了两类变更理由：「推流主循环」（抓屏 → 编码 → 发送的
//! 时序与降频策略）和「挂在会话上的 5 个独立任务」（数据报读取 / 音频 /
//! stats 采样 / 输入读取 / 光标形状）。前者是热路径、改一次要压测；后者是
//! **彼此独立的接线**、改一条不影响其他。拆开后主循环回归「一眼看清节奏」。
//!
//! # 这里的 5 个任务
//!
//! | 任务 | 干什么 | 断了会怎样 |
//! |---|---|---|
//! | `spawn_datagram_reader` | 收 QUIC 数据报里的鼠标移动 | 鼠标卡顿但按键仍可用 |
//! | `spawn_audio_task` | 采集系统声音走专用流 | 对端听不到声音 |
//! | `spawn_stats_sampler` | 采样本端 RTT / 丢包喂码控 | 弱网不缩码率 |
//! | `spawn_input_reader` | 收输入事件 + 心跳回 pong | 会话收口（控制通道断） |
//! | `maybe_send_cursor` | 每圈比对光标形状，变则发 | 对端光标形状不跟随 |
//!
//! # 🔴 两条不变量（搬到这里时保持原样，别顺手改）
//!
//! 1. **任何键鼠事件先 `notify_waiters` 再注入**（`spawn_input_reader`）：
//!    唤醒发生在注入前，DXGI 的 `AcquireNextFrame` 等待窗口正好覆盖注入
//!    生效所需的几毫秒——顺序反了拖动就跟不上手。
//! 2. **`spawn_input_reader` 与 `spawn_datagram_reader` 必须有界退出**：
//!    `read_frame` 自身无超时，连接悬着时任务会陪挂到 QUIC 空闲超时，
//!    所以每轮都包一层 500ms `select!`。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::input::{current_cursor_shape, InputEvent};
use super::protocol::{RcFrame, SessionPhase};
use super::service::RcService;
use crate::sync::transport::{read_frame, write_frame};

use super::inbound::{handle_inbound_input, InboundVideo};

impl InboundVideo {
    /// P0-3：数据报读取任务——发起端的鼠标移动走 QUIC 不可靠数据报
    /// （绝对坐标 latest-wins，丢包被下一帧校正；按键/滚轮仍在可靠流）。
    /// 视频大帧把可靠流堵住时，鼠标依然每一拍都进得来。
    pub(super) fn spawn_datagram_reader(&self) {
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
    pub(super) fn spawn_audio_task(&self) {
        use std::sync::atomic::AtomicBool;
        if !self.svc.audio_peer_wants() {
            return;
        }
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let conn = self.conn.clone();
        tauri::async_runtime::spawn(async move {
            let (tx, mut rx) =
                tokio::sync::mpsc::channel::<super::audio::AudioOut>(super::audio::AUDIO_CHAN_CAP);
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
    pub(super) fn spawn_stats_sampler(&self) {
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
    pub(super) async fn maybe_send_cursor(&mut self) {
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
    }

    /// 输入读取任务：End 帧收口；其余解成 InputEvent，心跳回 pong，其它交
    /// `handle_inbound_input`。半流断开同样收口（对端崩溃 / 网络断）。
    ///
    /// 🔴 任何键鼠事件都先 `notify_waiters` 提帧：让推流循环立刻醒过来抓一帧，
    /// 拖动窗口时画面跟着输入走，而不是等下一档位间隔。
    pub(super) fn spawn_input_reader(&self, mut recv: iroh::endpoint::RecvStream) {
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
}

/// P1：向发起端报告本机画面能力（fps120「高帧率+」可用性与主屏刷新率）。
/// 零拷贝门槛：硬件 D3D11-aware H.264 MFT + 单输出捕获范围 + 刷新 ≥100Hz，
/// 三者缺一就不许选——跑不到的档不卖。会话建立与范围变更时各发一次。
pub(super) async fn send_caps_frame(
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
    // R3：声明本机能读「鼠标移动数据报」。旧版对端没有这个字段 → 发起端
    // 解析为 false，会话 UI 提示升级；**不改传输路径**（见 §9 方案 R3）。
    let msg = serde_json::json!({
        "t": "caps",
        "fps120": fps120,
        "hz": hz,
        "hevc": hevc,
        "monitors": monitors,
        "dgram_input": true,
    });
    if let Ok(b) = serde_json::to_vec(&msg) {
        let mut guard = send.lock().await;
        let _ = write_frame(&mut guard, &b).await;
    }
}

/// 主屏逻辑尺寸（硬编打开用）。encode_bgra 在分辨率变化时会按新尺寸重开。
#[cfg(target_os = "windows")]
pub(super) fn primary_screen_size() -> (u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    (w.max(64) as u32, h.max(64) as u32)
}

/// 虚拟屏几何（硬编初始打开用）。会话中换范围时 encode_bgra 按新尺寸重开。
#[cfg(target_os = "windows")]
pub(super) fn virtual_screen_size() -> (i32, i32, i32, i32) {
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
