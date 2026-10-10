//! 单槽媒体流水线：捕获/编码与网络写入分开，每代参考链最多一帧待写。
use super::*;
use super::media::MediaWriter;
use std::sync::atomic::AtomicU64;

enum Payload {
    #[cfg(any(target_os="windows",target_os="macos"))]
    H264 { p: crate::rc::video_params::VideoPacket, sq: u32, ts: i64, cap: u16, enc: u16, codec: String },
    Jpeg(crate::rc::video::Encoded),
}
struct Job { generation: u64, queued: std::time::Instant, started_ms: u64, payload: Payload }

/// `InboundVideo::media_gate()` 的结果（P0：问门不再阻塞采集圈）。
pub(super) enum Gate {
    /// 本帧可以采集+编码+发送。
    Open,
    /// 本帧丢掉；`u64` 是下一次来问之前的毫秒数（`Flow::gate_retry_ms`，8..200ms）。
    Drop(u64),
    /// 会话或流水线已经没了，调用方退出循环。
    End,
}

pub(in crate::rc) struct MediaPipe {
    tx: tokio::sync::mpsc::Sender<Job>,
    generation: Arc<AtomicU64>,
    reset: Arc<tokio::sync::Notify>,
    paused: bool,
}

impl MediaPipe {
    fn new(video: &InboundVideo) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Job>(1);
        let generation = Arc::new(AtomicU64::new(0));
        let worker_generation = generation.clone();
        let reset = Arc::new(tokio::sync::Notify::new());
        let worker_reset = reset.clone();
        let mut writer = MediaWriter::new(video);
        tauri::async_runtime::spawn(async move {
            loop {
                if !writer.alive() { break; }
                let job = tokio::select! {
                    _ = worker_reset.notified() => { writer.discard_media_stream("generation-replaced"); continue; }
                    job = rx.recv() => match job { Some(job) => job, None => break },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => continue,
                };
                if job.generation != worker_generation.load(Ordering::SeqCst) { continue; }
                let queued_ms = job.queued.elapsed().as_millis();
                if writer.paused() || queued_ms > 150 {
                    log::info!("[RC-MEDIA] pending job discarded age={queued_ms}ms");
                    writer.discard_media_stream(if writer.paused() { "paused" } else { "job-expired" });
                    continue;
                }
                let written = tokio::select! {
                    _ = worker_reset.notified() => { writer.discard_media_stream("generation-replaced-during-write"); true }
                    result = async {
                        match job.payload {
                            #[cfg(any(target_os="windows",target_os="macos"))]
                            Payload::H264 { p, sq, ts, cap, enc, codec } =>
                                writer.send_via_video_plane(&p, sq, ts, cap, enc, &codec, job.started_ms).await,
                            Payload::Jpeg(frame) => writer.send_jpeg_plane(&frame, job.started_ms).await,
                        }
                    } => result,
                };
                if !written { break; }
            }
            writer.discard_media_stream("worker-ended");
        });
        Self { tx, generation, reset, paused: false }
    }

    pub(super) fn set_paused(&mut self, paused: bool) {
        // 停产不会取消 QUIC 已接受的旧帧；仅在暂停边沿唤醒 worker，
        // RESET 旧流及反馈待确认队列，恢复由 writer 强制新参考链。
        if paused && !self.paused { self.reset(); }
        self.paused = paused;
    }

    fn reset(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.reset.notify_one();
    }
    fn available(&self) -> bool { self.tx.capacity() > 0 }
    async fn send(&self, payload: Payload, started_ms: u64) -> bool {
        self.tx.send(Job { generation: self.generation.load(Ordering::SeqCst),
            queued: std::time::Instant::now(), started_ms, payload }).await.is_ok()
    }
}

impl InboundVideo {
    pub(super) fn media_started_ms(&self) -> u64 {
        // 限速只能比较本进程单调钟；墙钟采集时间戳留给协议/反馈，不参与节拍。
        (crate::rc::mono::mono_ms() as u64)
            .saturating_sub(self.last_frame_at.elapsed().as_millis() as u64)
    }

    fn ensure_media_pipe(&mut self) {
        if self.media_pipe.is_none() { self.media_pipe = Some(MediaPipe::new(self)); }
    }

    pub(super) fn discard_media_stream(&mut self) {
        if let Some(pipe) = &self.media_pipe { pipe.reset(); }
        self.force_key.store(true, Ordering::SeqCst);
        self.enc.lock().unwrap_or_else(|p| p.into_inner()).reset_reference();
    }

    /// 🔴 P0（2026-10-06）：**生产者不再被发送侧预算阻塞**。
    /// 旧实现 `wait_media_capacity()` 在采集圈前面空转到准入放行，于是「预算低」直接
    /// 表现为「帧率低」，控制器只看到交付变慢，分不清是线路窄还是我们自己断粮——实测
    /// 把 400kbps 地板当成线路能力钉死（`docs/链路切换画质回升-业界源码对照-2026-10-06.md` §4）。
    /// 现在拿不到额度就**丢掉这一帧**（WebRTC `video_stream_encoder.cc` 的
    /// "Do not encode this frame"、Sunshine `thread_safe.h` 的 32 帧有界队列 `drop_oldest`），
    /// 节拍照走，并把「本窗丢过帧」当作确凿需求证据回灌给 `Flow`（`note_drop`）。
    /// 返回值里的 `End` 就是旧实现 `false` 的那两条退出路径，语义不变。
    pub(super) fn media_gate(&mut self) -> Gate {
        self.ensure_media_pipe();
        // 预算刷新（含换路重播种）留在每次问门的时候做，与旧实现同一时刻。
        self.svc.media_budget_kbps(&self.my_id);
        if !self.svc.session_id_is(&self.my_id) { return Gate::End; }
        if self.media_pipe.as_ref().is_some_and(|p| p.tx.is_closed()) { return Gate::End; }
        let admission = self.svc.media_admission(&self.my_id);
        let slot_free = self.media_pipe.as_ref().is_some_and(|p| p.available());
        match admission {
            crate::rc::media_flow::Admission::Ready if slot_free => Gate::Open,
            // RESET 照旧重开参考链；不再原地等下一格，本帧丢掉即可。
            // ❗ 这条**不记**需求证据：RESET 说明 ACK 窗口是自己的债务，不是「链路还有余量」，
            // 记进去会立刻放行 P3 的 ×2 探测。
            crate::rc::media_flow::Admission::Reset => {
                self.discard_media_stream();
                Gate::Drop(self.svc.media_gate_retry_ms(&self.my_id))
            }
            // 字节窗满 / 发送债务未到期 / 单槽被在写的帧占着：三种都是「想发发不下」。
            _ => {
                self.svc.media_frame_dropped(&self.my_id);
                Gate::Drop(self.svc.media_gate_retry_ms(&self.my_id))
            }
        }
    }

    #[cfg(any(target_os="windows",target_os="macos"))]
    pub(super) async fn send_via_video_plane(&mut self, p: &crate::rc::video_params::VideoPacket,
        sq: u32, ts: i64, cap: u16, enc: u16, codec: &str) -> bool {
        self.ensure_media_pipe();
        self.media_pipe.as_ref().unwrap().send(Payload::H264 {
            p: crate::rc::video_params::VideoPacket { at_ms: p.at_ms, data: p.data.clone(), key: p.key, width: p.width, height: p.height },
            sq, ts, cap, enc, codec: codec.to_owned(),
        }, self.media_started_ms()).await
    }

    pub(super) async fn send_jpeg_plane(&mut self, frame: &crate::rc::video::Encoded) -> bool {
        self.ensure_media_pipe();
        self.media_pipe.as_ref().unwrap().send(Payload::Jpeg(crate::rc::video::Encoded {
            rect: frame.rect, refine: frame.refine, frame: frame.frame.clone(),
        }), self.media_started_ms()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pipe() -> (MediaPipe, tokio::sync::mpsc::Receiver<Job>) {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        (MediaPipe { tx, generation: Arc::new(AtomicU64::new(0)),
            reset: Arc::new(tokio::sync::Notify::new()), paused: false }, rx)
    }

    #[tokio::test]
    async fn pause_resets_idle_worker_once_and_can_pause_again_after_resume() {
        let (mut pipe, _rx) = pipe();
        pipe.set_paused(true);
        assert_eq!(pipe.generation.load(Ordering::SeqCst), 1);
        // 无新帧也必须唤醒 idle worker；通知须存许可，不能依赖接收端先等待。
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), pipe.reset.notified()).await.is_ok());
        pipe.set_paused(true);
        assert_eq!(pipe.generation.load(Ordering::SeqCst), 1);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), pipe.reset.notified()).await.is_err());
        pipe.set_paused(false);
        pipe.set_paused(true);
        assert_eq!(pipe.generation.load(Ordering::SeqCst), 2);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), pipe.reset.notified()).await.is_ok());
    }

    #[tokio::test]
    async fn pause_invalidates_queued_frame_even_when_resumed_before_worker_runs() {
        let (mut pipe, mut rx) = pipe();
        assert!(pipe.send(Payload::Jpeg(crate::rc::video::Encoded {
            rect:None,refine:false,frame:crate::rc::video::VideoFrame{width:2,height:2,jpeg:vec![1],at_ms:0,full:true,rect:None,codec:crate::rc::video::FrameCodec::Jpeg,key:true,cap_ms:0,enc_ms:0}
        }), 0).await);
        pipe.set_paused(true);
        pipe.set_paused(false);
        let job = rx.recv().await.unwrap();
        assert_ne!(job.generation, pipe.generation.load(Ordering::SeqCst));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), pipe.reset.notified()).await.is_ok());
    }
}
