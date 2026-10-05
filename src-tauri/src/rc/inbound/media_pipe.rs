//! 单槽媒体流水线：捕获/编码与网络写入分开，每代参考链最多一帧待写。
use super::*;
use super::media::MediaWriter;
use std::sync::atomic::AtomicU64;

enum Payload {
    H264 { p: crate::rc::encode_h264::H264Packet, sq: u32, ts: i64, cap: u16, enc: u16, codec: String },
    Jpeg(crate::rc::video::Encoded),
}
struct Job { generation: u64, queued: std::time::Instant, started_ms: u64, payload: Payload }

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

    pub(super) async fn wait_media_capacity(&mut self) -> bool {
        self.ensure_media_pipe();
        self.svc.media_budget_kbps(&self.my_id);
        loop {
            if !self.svc.session_id_is(&self.my_id) { return false; }
            if self.media_pipe.as_ref().is_some_and(|p| p.tx.is_closed()) { return false; }
            match self.svc.media_admission(&self.my_id) {
                crate::rc::media_flow::Admission::Ready if self.media_pipe.as_ref().unwrap().available() => return true,
                crate::rc::media_flow::Admission::Reset => self.discard_media_stream(),
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if self.svc.media_paused() { return true; }
        }
    }

    pub(super) async fn send_via_video_plane(&mut self, p: &crate::rc::encode_h264::H264Packet,
        sq: u32, ts: i64, cap: u16, enc: u16, codec: &str) -> bool {
        self.ensure_media_pipe();
        self.media_pipe.as_ref().unwrap().send(Payload::H264 {
            p: crate::rc::encode_h264::H264Packet { at_ms: p.at_ms, data: p.data.clone(), key: p.key, width: p.width, height: p.height },
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
        assert!(pipe.send(Payload::H264 {
            p: crate::rc::encode_h264::H264Packet { at_ms: 0, data: vec![1], key: true, width: 2, height: 2 },
            sq: 0, ts: 0, cap: 0, enc: 0, codec: "h264".into(),
        }, 0).await);
        pipe.set_paused(true);
        pipe.set_paused(false);
        let job = rx.recv().await.unwrap();
        assert_ne!(job.generation, pipe.generation.load(Ordering::SeqCst));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), pipe.reset.notified()).await.is_ok());
    }
}
