//! 发起端收流循环（Tier C 从 `service.rs` 拆出）。
//!
//! 原来是 `RcService::spawn_outbound_video` 里一个 127 行的 async block：
//! 「会话判定 / TTL / 控制帧分派（vrect / clip / clip_err / pong / inject_err）/
//! JPEG 整帧与脏块 / H.264 帧入帧池」全混在一起。现在圈成 `OutboundVideo`，
//! 每类帧一个方法。🔴 `my_id` 语义同 `inbound.rs`：收口只按任务启动时的会话
//! id 命中，不能按 peer（A2）。
//!
//! ⚠️ `run` 取 `mut self`（owned）而不是 `&self`/`&mut self` 引用：spawn 要求
//! `Send`，owned 结构体只需要 `Send`；理由与 `inbound.rs` 相同。

use super::protocol::RcFrame;
use super::service::{now_ms, RcService};
use super::video::{read_incoming, Incoming};
use crate::rc::jpeg::jpeg_dimensions;
use std::sync::Arc;

pub(super) struct OutboundVideo {
    svc: Arc<RcService>,
    peer: String,
    /// 任务启动时的会话 id；收口只认它。
    my_id: String,
    recv: iroh::endpoint::RecvStream,
    /// 🔴 断流时用它取「对端为什么关」：`RecvStream` 自己只有
    ///   `connection lost`（`ReadError` 的 Display 不插值内层，见
    ///   `service::explain` 的注释）——没有它，断流理由全丢。
    conn: iroh::endpoint::Connection,
    /// 与 JPEG 帧异步到达的脏矩形元数据：下一帧 JPEG 应用它。
    pending_rect: Option<super::video::DirtyRect>,
    /// 与 JPEG 帧异步到达的采集时间戳（vts 控制帧）：下一帧 JPEG 应用它。
    /// H.264 帧的 ts 随 meta JSON 一起到，不走这里。
    pending_ts: Option<i64>,
    /// P0-2 延迟分段：vts 帧带来的采集/编码耗时，随下一帧 JPEG 应用。
    pending_cap_ms: u16,
    pending_enc_ms: u16,
    /// 画布逻辑尺寸：整帧时从 JPEG 解出，脏块沿用。
    canvas_w: u32,
    canvas_h: u32,
    /// 最近一次告知对端的 RTT；变化明显才再发 NetHint。
    last_hint_rtt: i64,
    /// 对端主动 End 帧带的理由（P2-10）：原先 End 只 return false，理由被丢，
    /// 会话历史里记成「画面流中断」。注意它与 `end_reason`（断流 Err）分工：
    /// 对端主动结束**不**触发自动重连，断流才触发。
    peer_end_reason: Option<String>,
    /// P2-1：数据报视频重组器（流路径与数据报路径共用一把 seq 尺子）。
    #[cfg(target_os = "windows")]
    reasm: std::sync::Arc<std::sync::Mutex<super::vid_dgram::VidReassembler>>,
}

impl OutboundVideo {
    /// 会话存在、是出站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(super) fn try_new(
        svc: Arc<RcService>,
        peer: &str,
        recv: iroh::endpoint::RecvStream,
        conn: iroh::endpoint::Connection,
    ) -> Option<Self> {
        let my_id = {
            let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session
                .as_ref()
                .filter(|s| {
                    s.phase == super::protocol::SessionPhase::OutboundActive && s.peer == peer
                })
                .map(|s| s.id.clone())
        }?;
        Some(Self {
            svc,
            peer: peer.to_string(),
            my_id,
            recv,
            conn,
            pending_rect: None,
            pending_ts: None,
            pending_cap_ms: 0,
            pending_enc_ms: 0,
            canvas_w: 0,
            canvas_h: 0,
            last_hint_rtt: -1,
            peer_end_reason: None,
            #[cfg(target_os = "windows")]
            reasm: std::sync::Arc::new(std::sync::Mutex::new(
                super::vid_dgram::VidReassembler::new(),
            )),
        })
    }

    pub(super) async fn run(mut self) {
        // Q5：会话建立即把本机配置的码率倍率推给被控端（一次）。用户在会话中
        // 改下拉走 rc_send_input；这里兜「上次设置的偏好要对这场会话生效」。
        // 100 = 跟随链路，不用发。此刻必是 OutboundActive（try_new 已核过）。
        let pct = self.svc.user_bitrate_pct_from_cfg();
        if pct != 100 {
            let svc = self.svc.clone();
            tauri::async_runtime::spawn(async move {
                let _ = svc
                    .send_input(&super::input::InputEvent::SetBitratePct { pct })
                    .await;
            });
        }
        // P0-4：发起端本端采样丢包率（收视频流的这条路 = 画质路径），
        // 500ms 一拍喂给 status，HUD 显示「丢包 x.x%」。
        self.spawn_loss_sampler();
        // P2-1：视频数据报读取（P 帧低延迟通道），与可靠流并行
        self.spawn_video_dgram_reader();
        // G3：音频流接收（被控端另开的单向流），与视频两条路并行
        self.spawn_audio_acceptor();
        // 断流的真实理由（Err 路径才有）；其它退出路径维持原来的「画面流中断」。
        let mut end_reason: Option<String> = None;
        loop {
            if !self
                .svc
                .session_is(super::protocol::SessionPhase::OutboundActive, &self.peer)
            {
                break;
            }
            if self.svc.session_expired() {
                log::info!("[RC] 发起端会话超过 TTL，自动结束");
                self.svc.force_end_if_session(&self.my_id, "会话超时").await;
                break;
            }
            match read_incoming(&mut self.recv).await {
                Ok(Incoming::Control(bytes)) => {
                    if !self.handle_control(&bytes) {
                        break;
                    }
                }
                Ok(Incoming::Jpeg(f)) => self.handle_jpeg(f),
                Ok(Incoming::H264 {
                    key,
                    width,
                    height,
                    data,
                    ts,
                    cap_ms,
                    enc_ms,
                    sq,
                    codec,
                }) => self.handle_h264(key, width, height, data, ts, cap_ms, enc_ms, sq, codec),
                Err(e) => {
                    // ❗ 错误必须过 `explain`：对端以「未配对 / 忙 / 被禁」为由关连接时，
                    //   `read_incoming` 报的原始错误只有 `读帧长度失败：connection lost`
                    //   （`ReadError` 的 Display 不插值内层 `ConnectionError`）——
                    //   不拼一下，断流理由全丢，用户只能猜「对方是不是关机了」。
                    let e = super::service::explain(&self.conn, e);
                    log::info!("[RC] 画面流结束：{e}");
                    end_reason = Some(e);
                    break;
                }
            }
        }
        // P0：收流失败 ≠ 用户点了结束，但会话必须收口，否则界面一直「可控」。
        // 先比对 id 再清槽位——新会话建立时会直接覆盖 outbound_send，不清不会漏，
        // 但若不比对，旧任务会把新会话的发送半流清掉。
        if self.svc.session_id_is(&self.my_id) {
            self.svc.clear_outbound_link().await;
        }
        // 断流理由能带就带（`end_session` 会把它记进历史 / 显示给用户）；
        // 对端主动 End 的理由优先级最高（P2-10 修正：原先被丢、显示成
        // 「画面流中断」）；非断流退出（会话已不在）维持原话。
        let reason = self
            .peer_end_reason
            .clone()
            .or_else(|| end_reason.clone())
            .unwrap_or_else(|| "画面流中断".to_string());
        // Q6：断流前取一场会话的能力/设备名（force_end 之后就没有会话可查了）
        let ended = self.svc.session_brief_if(&self.my_id);
        self.svc.force_end_if_session(&self.my_id, &reason).await;
        // Q6：只在**异常断流**（读流 Err）时安排自动重连——用户主动结束、
        // 对端主动结束、TTL 到期都不走这条（那些路径 end_reason 为 None）。
        if end_reason.is_some() {
            if let Some((cap, peer_name)) = ended {
                self.svc
                    .begin_auto_reconnect(&self.peer, peer_name, cap);
            }
        }
    }

    /// P2-1：视频数据报读取任务。P 帧走 QUIC datagram（不可靠 + XOR FEC），
    /// 重组完成的帧直接进 outbox；流路径的关键帧到达时（handle_h264）重置
    /// 重组器。有界退出（P0-1 B5 同款）：500ms 一拍查会话。
    fn spawn_video_dgram_reader(&self) {
        #[cfg(target_os = "windows")]
        {
            let svc = self.svc.clone();
            let peer = self.peer.clone();
            let conn = self.conn.clone();
            let reasm = self.reasm.clone();
            tauri::async_runtime::spawn(async move {
            let mut last_key_req: Option<std::time::Instant> = None;
            loop {
                if !svc.session_is(super::protocol::SessionPhase::OutboundActive, &peer) {
                    break;
                }
                let dg = tokio::select! {
                    r = conn.read_datagram() => match r {
                        Ok(b) => b,
                        Err(_) => break,
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => continue,
                };
                let (frames, damaged) = {
                    let mut g = reasm.lock().unwrap_or_else(|p| p.into_inner());
                    let frames = g.feed(&dg);
                    let damaged = g.take_damaged();
                    (frames, damaged)
                };
                // P2-1 D1：数据报侧丢帧是「静默」的——帧根本到不了前端，前端只在
                // 解码出错时才发 request_key。引用链断裂必须在这里喊话，把
                // ForceKeyFrame 自愈从「等 1s 自然 GOP」提速到 RTT 级。限频 1s/次。
                let due = last_key_req
                    .map(|t| t.elapsed().as_millis() >= 1000)
                    .unwrap_or(true);
                if damaged && due {
                    last_key_req = Some(std::time::Instant::now());
                    let svc = svc.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = svc
                            .send_input(&super::input::InputEvent::RequestKey)
                            .await;
                    });
                }
                for f in frames {
                    push_h264_frame(
                        &svc,
                        f.key,
                        f.width,
                        f.height,
                        f.data,
                        f.at_ms,
                        f.cap_ms,
                        f.enc_ms,
                        f.codec,
                    );
                }
            }
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = &self.conn;
        }
    }

    /// G3：音频流接收。被控端为音频**另开**单向 QUIC 流：先写 `PPAUD1` 头 +
    /// AAC 配置（采样率/声道/ASC），其后每包 `u32 len | u8 type | u64 pts | payload`。
    /// 本循环持续 accept_uni：被控端静音→恢复会换新流，旧流 EOF 后新流会被这里
    /// 兜住。非音频流（旧版本对端不会发；陌生协议）头识别失败直接关。
    /// 有界退出同 P0-1 B5：500ms 一拍查会话。
    fn spawn_audio_acceptor(&self) {
        #[cfg(target_os = "windows")]
        {
            let svc = self.svc.clone();
            let peer = self.peer.clone();
            let conn = self.conn.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    if !svc.session_is(super::protocol::SessionPhase::OutboundActive, &peer) {
                        break;
                    }
                    let mut stream = tokio::select! {
                        r = conn.accept_uni() => match r {
                            Ok(s) => s,
                            Err(_) => break,
                        },
                        _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => continue,
                    };
                    // ── 流头 ──
                    let mut head = [0u8; super::audio::MAGIC.len() + 4];
                    if stream.read_exact(&mut head).await.is_err() {
                        continue;
                    }
                    let json_len = u32::from_le_bytes(head[super::audio::MAGIC.len()..].try_into().unwrap()) as usize;
                    if json_len == 0 || json_len > 4096 {
                        continue;
                    }
                    let mut json = vec![0u8; json_len];
                    if stream.read_exact(&mut json).await.is_err() {
                        continue;
                    }
                    let mut whole = Vec::with_capacity(head.len() + json.len());
                    whole.extend_from_slice(&head);
                    whole.extend_from_slice(&json);
                    let Some((cfg, _used)) = super::audio::try_parse_stream_header(&whole) else {
                        log::debug!("[RC] 收到非音频单向流，已忽略");
                        continue;
                    };
                    log::info!(
                        "[RC] 音频流已接通：{}Hz 立体声 {}kbps",
                        cfg.sr,
                        cfg.br
                    );
                    svc.audio_begin(cfg);
                    // ── 包循环 ──
                    loop {
                        let mut lb = [0u8; 4];
                        if stream.read_exact(&mut lb).await.is_err() {
                            break;
                        }
                        let n = u32::from_le_bytes(lb) as usize;
                        // type(1) + pts(8) + payload；上限 64KB（128kbps 一帧几百字节）
                        if !(9..=64 * 1024).contains(&n) {
                            break;
                        }
                        let mut body = vec![0u8; n];
                        if stream.read_exact(&mut body).await.is_err() {
                            break;
                        }
                        let pts = u64::from_le_bytes(body[1..9].try_into().unwrap());
                        svc.audio_push(pts, body[9..].to_vec());
                    }
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (&self.svc, &self.peer, &self.conn);
        }
    }

    /// P0-4：发起端丢包率采样。用本端 QUIC stats 的窗口增量算 ‰，
    /// EMA 平滑后写入 svc；窗口没有新包就不更新。
    fn spawn_loss_sampler(&self) {
        let svc = self.svc.clone();
        let peer = self.peer.clone();
        let conn = self.conn.clone();
        tauri::async_runtime::spawn(async move {
            let mut prev: Option<(u64, u64)> = None;
            let mut ema: u64 = 0;
            let mut has_ema = false;
            loop {
                if !svc.session_is(super::protocol::SessionPhase::OutboundActive, &peer) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let st = conn.stats();
                // iroh 扁平计数：分母用本端发出的 UDP 包数
                let (lost, sent) = (st.lost_packets, st.udp_tx.datagrams);
                if let Some((pl, ps)) = prev {
                    if sent > ps {
                        let d_lost = lost.saturating_sub(pl);
                        let pm = d_lost * 1000 / (sent - ps).max(1);
                        ema = if has_ema { (ema * 7 + pm * 3) / 10 } else { has_ema = true; pm };
                        svc.note_remote_loss(ema as u32);
                    }
                }
                prev = Some((lost, sent));
            }
        });
    }

    /// 控制帧：`End` 返 false（退出循环）；其余（vrect / vts / clip / clip_err /
    /// pong / inject_err / cursor）就地消化，返 true 继续。
    fn handle_control(&mut self, bytes: &[u8]) -> bool {
        match RcFrame::decode(bytes) {
            Ok(RcFrame::End { reason }) => {
                log::info!("[RC] 对端结束：{reason}");
                // 理由带出去进会话历史（P2-10）。不设 end_reason（那是断流
                // Err 的标记，is_some 会触发自动重连）——对端主动结束不重连。
                self.peer_end_reason = Some(reason);
                return false;
            }
            Ok(_) => {}
            Err(_) => {
                // 可能是 vrect 元数据或剪贴板回包
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
                    match v.get("t").and_then(|x| x.as_str()) {
                        Some("vrect") => {
                            self.pending_rect = Some(super::video::DirtyRect {
                                x: v["x"].as_u64().unwrap_or(0) as u32,
                                y: v["y"].as_u64().unwrap_or(0) as u32,
                                w: v["w"].as_u64().unwrap_or(0) as u32,
                                h: v["h"].as_u64().unwrap_or(0) as u32,
                            });
                        }
                        Some("vts") => {
                            // P2-10：采集时间戳随帧到，前端算「画面链路延迟」用
                            self.pending_ts = Some(v["ts"].as_i64().unwrap_or(0));
                            // P0-2：采集/编码耗时同帧到，HUD 分段显示
                            self.pending_cap_ms = v["cap"].as_u64().unwrap_or(0).min(u16::MAX as u64) as u16;
                            self.pending_enc_ms = v["enc"].as_u64().unwrap_or(0).min(u16::MAX as u64) as u16;
                        }
                        Some("cursor") => {
                            // P1-6：远端光标形状（变化才发）
                            if let Some(sh) = v.get("s").and_then(|x| x.as_str()) {
                                self.svc.set_remote_cursor(sh.to_string());
                            }
                        }
                        Some("clip") => {
                            if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                                self.svc.set_remote_clipboard(t.to_string());
                            }
                        }
                        Some("clip_err") => {
                            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                log::warn!("[RC] 剪贴板拉回失败：{e}");
                                // P2-5：失败原因带给 pull_clipboard 转 Err（并推进
                                // seq 唤醒等待）——不再折叠成空串冒充「剪贴板为空」。
                                self.svc.clip_pull_failed(e.to_string());
                            }
                        }
                        Some("pong") => {
                            if let Some(ts) = v.get("ts").and_then(|x| x.as_i64()) {
                                let t1 = now_ms();
                                let rtt = t1.saturating_sub(ts);
                                self.svc.note_rtt(rtt);
                                // P0-1 A3：host 在收到 ping 时刻打 hts（它的时钟）。
                                // 偏差（host−本机）= hts − (t1 − rtt/2)：网络对称假设下，
                                // host 收包时刻折算到本机时钟是 t1 − rtt/2。
                                if let Some(hts) = v.get("hts").and_then(|x| x.as_i64()) {
                                    if hts > 0 && rtt > 0 {
                                        let skew = hts - (t1 - rtt / 2);
                                        self.svc.note_clock_skew(skew, rtt);
                                    }
                                }
                                // R5.B2：RTT 明显变化时告知被控端缩/放码率（±40ms 或跨 100ms 档）
                                let prev = self.last_hint_rtt;
                                let need = prev < 0
                                    || rtt.abs_diff(prev) >= 40
                                    || (prev < 100) != (rtt < 100)
                                    || (prev < 200) != (rtt < 200);
                                if need {
                                    self.last_hint_rtt = rtt;
                                    let svc = self.svc.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let _ = svc
                                            .send_input(&super::input::InputEvent::NetHint {
                                                rtt_ms: rtt,
                                            })
                                            .await;
                                    });
                                }
                            }
                        }
                        Some("host_audio") => {
                            // G3-B/C：对端报来的**主机侧音频状态**。两者都是对端的事实，
                            // 本机只负责如实显示：`local_mute` = 对方按了「不发送声音」，
                            // `spk_mute` = 对方主机扬声器静音中。`err` 只在对方动作失败时带。
                            let st = super::service::PeerHostAudio {
                                local_mute: v
                                    .get("local_mute")
                                    .and_then(|x| x.as_bool())
                                    .unwrap_or(false),
                                spk_mute: v.get("spk_mute").and_then(|x| x.as_bool()).unwrap_or(false),
                                err: v.get("err").and_then(|x| x.as_str()).map(str::to_string),
                            };
                            self.svc.set_peer_host_audio(st);
                        }
                        Some("caps") => {
                            // P1：被控端画面能力（fps120 可用性 + 刷新率），UI 诚实出档
                            let fps120 = v.get("fps120").and_then(|x| x.as_bool()).unwrap_or(false);
                            let hz = v
                                .get("hz")
                                .and_then(|x| x.as_u64())
                                .unwrap_or(0)
                                .min(1000) as u32;
                            // Q3：对端 HEVC 硬编可用性（旧版本对端没有这个字段 → false）
                            let hevc = v.get("hevc").and_then(|x| x.as_bool()).unwrap_or(false);
                            // Q7：对端在线显示器列表（旧版本对端没有这个字段 → 空表）
                            let monitors = v
                                .get("monitors")
                                .and_then(|x| serde_json::from_value(x.clone()).ok())
                                .unwrap_or_default();
                            // R3：旧版对端（官方 7.2.1 及更早）没有这个字段 → false
                            let dgram_input =
                                v.get("dgram_input").and_then(|x| x.as_bool()).unwrap_or(false);
                            self.svc.note_peer_caps(fps120, hz, hevc, monitors, dgram_input);
                        }
                        Some("inject_err") => {
                            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                log::warn!("[RC] 被控端注入失败：{e}");
                                self.svc.set_inject_err(e.to_string());
                            }
                        }
                        Some("clip_push_err") => {
                            // D11：本端推过去的剪贴板，被控端明确没写进去
                            // （只看会话 / 超限 / 写剪贴板失败）。过去这条腿连回帧
                            // 都没有，界面照样报「已推送」——现在立刻报出原因。
                            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                log::warn!("[RC] 推送剪贴板被拒/失败：{e}");
                                self.svc.set_clip_push_err(e.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        true
    }

    /// JPEG 帧：整帧用轻量 JPEG 头读尺寸（不解像素）；脏块沿用画布尺寸。
    ///
    /// 🔴 帧同时进 `frame_outbox`：H.264 的 P 帧与 JPEG 脏块帧**都不能丢**，
    /// 槽位 latest-wins 只能给旧命令兜底；新前端走 outbox 全序批量取。
    fn handle_jpeg(&mut self, f: super::video::VideoFrame) {
        let rect = self.pending_rect.take();
        // P2-10：用被控端采集时刻（vts 帧带来）；旧对端没带就退回收包时刻
        let ts = self
            .pending_ts
            .take()
            .filter(|t| *t > 0)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        // P0-2：采集/编码耗时（vts 帧带来；旧对端缺省 0 = HUD 不显示分段）
        let cap_ms = self.pending_cap_ms;
        let enc_ms = self.pending_enc_ms;
        self.pending_cap_ms = 0;
        self.pending_enc_ms = 0;
        if rect.is_none() {
            if let Some((w, h)) = jpeg_dimensions(&f.jpeg) {
                self.canvas_w = w;
                self.canvas_h = h;
            }
        }
        let (w, h) = (self.canvas_w, self.canvas_h);
        let frame = super::video::VideoFrame {
            width: w,
            height: h,
            jpeg: f.jpeg,
            at_ms: ts,
            full: rect.is_none(),
            rect,
            codec: super::video::FrameCodec::Jpeg,
            key: rect.is_none(),
            cap_ms,
            enc_ms,
        };
        self.svc.set_frame(frame.clone());
        self.svc.push_outbox(frame);
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_h264(
        &mut self,
        key: bool,
        width: u32,
        height: u32,
        data: Vec<u8>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
        sq: u32,
        codec: super::video::FrameCodec,
    ) {
        // P2-1：走流的关键帧 = 数据报重组器的锚。新对端的 sq 从 1 起（0 是
        // 「旧对端无序号」的保留值，见 `vid_dgram.rs` 的 `VidDgramSender`）。
        #[cfg(target_os = "windows")]
        let mut drained: Vec<super::vid_dgram::ReasmFrame> = Vec::new();
        if key && sq > 0 {
            #[cfg(target_os = "windows")]
            {
                drained = self
                    .reasm
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .reset_after_stream_key(sq);
            }
        }
        push_h264_frame(&self.svc, key, width, height, data, ts, cap_ms, enc_ms, codec);
        // D2：锚定后按序补交付缓冲完整的 P 帧——走流的关键帧被拥塞延迟时，
        // 先到的数据报 P 帧已缓存，等锚一到就能续播（不再整 GOP 作废）。
        #[cfg(target_os = "windows")]
        for f in drained {
            push_h264_frame(
                &self.svc,
                f.key,
                f.width,
                f.height,
                f.data,
                f.at_ms,
                f.cap_ms,
                f.enc_ms,
                f.codec,
            );
        }
    }
}

/// P2-1：H.264/HEVC（Q3）帧入池（可靠流与数据报两条路共用这一处路由）。
/// 编码标准随帧走：流路径来自元数据 `c` 字段，数据报路径来自分片头的
/// FLAG_HEVC 位——不做跨通道状态推断。
#[allow(clippy::too_many_arguments)]
fn push_h264_frame(
    svc: &RcService,
    key: bool,
    width: u32,
    height: u32,
    data: Vec<u8>,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
    codec: super::video::FrameCodec,
) {
    let frame = super::video::VideoFrame {
        width,
        height,
        jpeg: data,
        at_ms: if ts > 0 { ts } else { chrono::Utc::now().timestamp_millis() },
        full: true,
        rect: None,
        codec,
        key,
        cap_ms,
        enc_ms,
    };
    svc.set_frame(frame.clone());
    svc.push_outbox(frame);
}

#[cfg(test)]
mod tests {
    /// 🔴 守卫：收流断开的错误**真的**过了 `explain`，且理由带进了会话结束原因。
    ///
    /// 这条治的是 09-17 那类「工具写好了、没人接」：`service::explain` 早已存在
    /// （同步侧 09-06 就有），但本文件的收流 Err 分支一直裸报——对端以
    /// 「未配对 / 忙 / 被禁」关连接时，用户只看到 `connection lost`，分档全失效。
    #[test]
    fn test_守卫_收流断开的理由真的过了explain() {
        let src = include_str!("outbound.rs");
        assert!(
            src.contains("super::service::explain(&self.conn, e)"),
            "收流 Err 分支没过 `explain`——对端关连接的理由会退化成 `connection lost`"
        );
        assert!(
            src.contains("let reason = self")
                && src.contains("peer_end_reason"),
            "对端 End 帧的理由要带进 `force_end_if_session`（P2-10：否则历史记成「画面流中断」）"
        );
        // 连接句柄必须从 `dial_and_request` 交出来——没有它，收流侧拿不到 `close_reason`。
        let svc = include_str!("service.rs");
        assert!(
            svc.contains("Ok((capability, conn, send, recv))"),
            "`dial_and_request` 不再返回连接句柄了——收流侧的 `explain` 会拿不到 `close_reason`"
        );
    }
}
