//! 会话归属、媒体闭环与上屏打点；仅在有待确认帧时运行反馈任务。
use super::*;
use crate::rc::media_flow::{Admission, Flow, MediaFeedback, Receiver};

#[derive(Default)]
pub(super) struct MediaState {
    id: String,
    flow: Flow,
    receiver: Receiver,
    sending_feedback: bool,
    feedback_supported: bool,
    last_health_log_ms: u64,
}

impl RcService {
    pub(in crate::rc) fn media_paused(&self) -> bool {
        self.video_paused() || self.peer_background_since() > 0
    }

    pub(in crate::rc) fn configure_media_feedback(&self, id: &str, supported: bool) {
        self.with_media(id, |s| s.feedback_supported = supported);
    }

    fn with_media<T>(&self, id: &str, f: impl FnOnce(&mut MediaState) -> T) -> Option<T> {
        // 短暂同时持锁，禁止旧会话的迟到采样重置新会话控制器。
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !inner.session.as_ref().is_some_and(|s| s.id == id) { return None; }
        let mut state = self.media_state.lock().unwrap_or_else(|p| p.into_inner());
        if state.id != id { *state = MediaState { id: id.to_owned(), ..Default::default() }; }
        Some(f(&mut state))
    }

    pub(in crate::rc) fn media_budget_kbps(&self, id: &str) -> u32 {
        let relay = !matches!(self.link.path_kind_str().as_str(), "lan" | "direct");
        self.with_media(id, |s| s.flow.budget(relay, self.stream.media_ceiling_kbps())).unwrap_or(400)
    }

    pub(in crate::rc) fn media_fps_limit(&self, id: &str) -> u32 {
        let relay = !matches!(self.link.path_kind_str().as_str(), "lan" | "direct");
        self.with_media(id, |s| { s.flow.budget(relay, self.stream.media_ceiling_kbps()); s.flow.fps_limit(relay) }).unwrap_or(10)
    }

    pub(in crate::rc) fn media_admission(&self, id: &str) -> Admission {
        // 老客户端没有 ACK 任务，不能因等待不存在的反馈而反复 RESET。
        self.with_media(id, |s| if s.feedback_supported {
            let now = crate::rc::mono::mono_ms() as u64;
            let rtt = self.video_rtt_ms();
            let admission = s.flow.admission(now, rtt);
            if admission == Admission::Reset {
                log::info!("[RC-MEDIA] admission RESET session={id} {}", s.flow.reset_diagnostics(now, rtt));
            }
            admission
        } else { Admission::Ready })
            .unwrap_or(Admission::Wait)
    }

    pub(in crate::rc) fn media_resolution_limit(&self, id: &str) -> u32 {
        self.with_media(id, |s| s.flow.resolution_limit(crate::rc::mono::mono_ms() as u64)).unwrap_or(1280)
    }

    pub(in crate::rc) fn media_sent(&self, id: &str, started_ms: u64, at_ms: i64, bytes: usize) {
        self.with_media(id, |s| if s.feedback_supported {
            s.flow.sent(crate::rc::mono::mono_ms() as u64, started_ms, at_ms, bytes);
        });
    }

    pub(in crate::rc) fn media_discarded(&self, id: &str) {
        let loss = self.stream.loss_permille().max(0);
        self.with_media(id, |s| s.flow.discard(crate::rc::mono::mono_ms() as u64, loss));
    }

    pub(in crate::rc) fn apply_media_feedback(&self, f: &MediaFeedback) {
        let id = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(s) = inner.session.as_ref() else { return; };
            s.id.clone()
        };
        self.with_media(&id, |s| {
            let before = s.flow.kbps;
            let now = crate::rc::mono::mono_ms() as u64;
            let loss = self.loss_permille();
            s.flow.feedback(now, f, self.stream.media_ceiling_kbps(), loss);
            // 覆盖旧 NetHint 帧龄口径：auto_quality 也应看到额外积压，而非传播时间。
            self.set_peer_queue_ms(s.flow.queue_ms);
            // 预算压到地板后也留有界健康采样，否则持续的码控压力会完全不见。
            if before != s.flow.kbps || now.saturating_sub(s.last_health_log_ms) >= 5_000 {
                s.last_health_log_ms = now;
                log::info!("[RC-MEDIA] budget={}kbps delivered={}kbps queue={}ms receive_queue={:?}ms display_delay={:?}ms sample={}ms presented={} received={} rtt={}ms loss={}pm",
                    s.flow.kbps, s.flow.delivered_kbps, s.flow.queue_ms, f.receive_queue_ms,
                    f.display_delay_ms, f.sample_ms, f.presented_at_ms, f.received_at_ms, self.video_rtt_ms(), loss);
            }
        });
    }

    pub(in crate::rc) fn keep_media_queue_hint(&self) {
        let state = self.media_state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(queue) = state.flow.feedback_queue() { self.set_peer_queue_ms(queue); }
    }

    pub(in crate::rc) fn note_media_presented(&self, id: &str, at_ms: i64) -> Result<(), String> {
        self.with_media(id, |s| {
            s.receiver.presented(at_ms, crate::rc::mono::mono_ms() as u64);
        }).ok_or_else(|| "画面属于已结束的会话".into())
    }

    pub(in crate::rc) fn note_media_received(self: &Arc<Self>, id: &str, frame: &crate::rc::video::VideoFrame) {
        let now = crate::rc::mono::mono_ms() as u64;
        let age = (now_ms() - frame.at_ms + self.clock_skew_ms()).max(0);
        let relay = !matches!(self.link.path_kind_str().as_str(), "lan" | "direct");
        let schedule = self.with_media(id, |s| {
            // 视频已移到独立 uni 流，主控制流的 note_inbound 不再覆盖这些帧。
            // 必须在会话归属校验之内更新，旧 reader 不能给新会话续命。
            self.link.note_inbound();
            s.receiver.set_path(relay);
            s.receiver.receive(now, frame.at_ms, frame.jpeg.len(), age);
            if s.sending_feedback { return false; }
            s.sending_feedback = true;
            true
        }).unwrap_or(false);
        if !schedule { return; }
        let svc = self.clone();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            loop {
                // 仅有待反馈帧时才存活，首帧和静止前最后一帧也会被确认。
                tokio::time::sleep(std::time::Duration::from_millis(crate::rc::media_flow::FEEDBACK_MS)).await;
                let media = svc.with_media(&id, |s|
                    s.receiver.take_feedback(crate::rc::mono::mono_ms() as u64)).flatten();
                if let Some(media) = media {
                    let event = crate::rc::input::InputEvent::NetHint {
                        rtt_ms: svc.last_rtt_ms(), queue_ms: None, frame_loss_pm: None, media: Some(media),
                    };
                    let mut send = svc.outbound_send.lock().await;
                    // 等待发送锁期间可能切了会话；旧反馈绝不能写入新连接。
                    if svc.session_id_is(&id) {
                        if let (Some(stream), Ok(bytes)) = (send.as_mut(), serde_json::to_vec(&event)) {
                            let _ = crate::sync::transport::write_frame(stream, &bytes).await;
                        }
                    }
                }
                let again = svc.with_media(&id, |s| {
                    if s.receiver.has_pending() { true }
                    else { s.sending_feedback = false; false }
                }).unwrap_or(false);
                if !again { break; }
            }
        });
    }
}
