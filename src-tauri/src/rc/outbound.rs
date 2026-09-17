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
    /// 与 JPEG 帧异步到达的脏矩形元数据：下一帧 JPEG 应用它。
    pending_rect: Option<super::video::DirtyRect>,
    /// 画布逻辑尺寸：整帧时从 JPEG 解出，脏块沿用。
    canvas_w: u32,
    canvas_h: u32,
    /// 最近一次告知对端的 RTT；变化明显才再发 NetHint。
    last_hint_rtt: i64,
}

impl OutboundVideo {
    /// 会话存在、是出站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(super) fn try_new(
        svc: Arc<RcService>,
        peer: &str,
        recv: iroh::endpoint::RecvStream,
    ) -> Option<Self> {
        let my_id = {
            let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session
                .as_ref()
                .filter(|s| s.phase == super::protocol::SessionPhase::OutboundActive && s.peer == peer)
                .map(|s| s.id.clone())
        }?;
        Some(Self {
            svc,
            peer: peer.to_string(),
            my_id,
            recv,
            pending_rect: None,
            canvas_w: 0,
            canvas_h: 0,
            last_hint_rtt: -1,
        })
    }

    pub(super) async fn run(mut self) {
        loop {
            if !self.svc.session_is(super::protocol::SessionPhase::OutboundActive, &self.peer) {
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
                }) => self.handle_h264(key, width, height, data),
                Err(e) => {
                    log::info!("[RC] 画面流结束：{e}");
                    break;
                }
            }
        }
        // P0：收流失败 ≠ 用户点了结束，但会话必须收口，否则界面一直「可控」。
        // 先比对 id 再清槽位——新会话建立时会直接覆盖 outbound_send，不清不会漏，
        // 但若不比对，旧任务会把新会话的发送半流清掉。
        if self.svc.session_id_is(&self.my_id) {
            *self.svc.outbound_send.lock().await = None;
        }
        self.svc.force_end_if_session(&self.my_id, "画面流中断").await;
    }

    /// 控制帧：`End` 返 false（退出循环）；其余（vrect / clip / clip_err /
    /// pong / inject_err）就地消化，返 true 继续。
    fn handle_control(&mut self, bytes: &[u8]) -> bool {
        match RcFrame::decode(bytes) {
            Ok(RcFrame::End { reason }) => {
                log::info!("[RC] 对端结束：{reason}");
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
                        Some("clip") => {
                            if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                                self.svc.set_remote_clipboard(t.to_string());
                            }
                        }
                        Some("clip_err") => {
                            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                log::warn!("[RC] 剪贴板拉回失败：{e}");
                                // 推进 seq：让 pull 立刻返回；内容为空表示失败
                                self.svc.set_remote_clipboard(String::new());
                            }
                        }
                        Some("pong") => {
                            if let Some(ts) = v.get("ts").and_then(|x| x.as_i64()) {
                                let rtt = now_ms().saturating_sub(ts);
                                self.svc.note_rtt(rtt);
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
                        Some("inject_err") => {
                            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                                log::warn!("[RC] 被控端注入失败：{e}");
                                self.svc.set_inject_err(e.to_string());
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
    fn handle_jpeg(&mut self, f: super::video::VideoFrame) {
        let rect = self.pending_rect.take();
        if rect.is_none() {
            if let Some((w, h)) = jpeg_dimensions(&f.jpeg) {
                self.canvas_w = w;
                self.canvas_h = h;
            }
        }
        let (w, h) = (self.canvas_w, self.canvas_h);
        self.svc.set_frame(super::video::VideoFrame {
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

    fn handle_h264(&mut self, key: bool, width: u32, height: u32, data: Vec<u8>) {
        self.svc.set_frame(super::video::VideoFrame {
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
}
