//! 独立媒体流：所有废弃路径 RESET；取消半包后必须整流重建。
use super::*;
use crate::rc::media::{discard_stream, MEDIA_PRIORITY, WRITE_BUDGET};

fn request_key_once(requested: &mut bool, force_key: &AtomicBool) {
    if !*requested {
        *requested = true;
        force_key.store(true, Ordering::SeqCst);
    }
}

pub(super) struct MediaWriter {
    svc: Arc<RcService>, my_id: String, conn: iroh::endpoint::Connection,
    enc: Arc<std::sync::Mutex<crate::rc::video::EncoderState>>,
    force_key: Arc<AtomicBool>,
    video_stream: Option<iroh::endpoint::SendStream>, video_stream_codec: Option<String>,
    stream_last_write_ms: u64, stream_melt: bool, melt_since: Option<std::time::Instant>,
    plane_await_idr: bool, plane_key_requested: bool, plane_fail_streak: u32,
}

impl MediaWriter {
    pub(super) fn new(v: &InboundVideo) -> Self {
        Self { svc: v.svc.clone(), my_id: v.my_id.clone(), conn: v.conn.clone(), enc: v.enc.clone(),
            force_key: v.force_key.clone(), video_stream: None, video_stream_codec: None,
            stream_last_write_ms: 0, stream_melt: false, melt_since: None, plane_await_idr: true,
            plane_key_requested: false, plane_fail_streak: 0 }
    }
    pub(super) fn alive(&self) -> bool { self.svc.session_id_is(&self.my_id) }
    pub(super) fn paused(&self) -> bool { self.svc.media_paused() }

    pub(super) fn discard_media_stream(&mut self, reason: &str) {
        log::info!("[RC-MEDIA] stream RESET session={} reason={reason} stream={:?} write={}ms",
            self.my_id, self.video_stream.as_ref().map(|s| s.id()), self.stream_last_write_ms);
        discard_stream(&mut self.video_stream);
        self.video_stream_codec = None;
        self.svc.media_discarded(&self.my_id);
        self.stream_last_write_ms = 0;
        self.stream_melt = false;
        self.melt_since = None;
        self.plane_await_idr = true;
        self.plane_key_requested = false;
        request_key_once(&mut self.plane_key_requested, &self.force_key);
        self.enc
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reset_reference();
    }

    async fn ensure_media_stream(&mut self, codec: &str) -> bool {
        if self.stream_last_write_ms >= super::video::MELT_SLOW_MS {
            self.melt_since.get_or_insert(std::time::Instant::now());
        } else if self.stream_last_write_ms < super::video::MELT_EXIT_MS {
            self.melt_since = None;
        }
        if self
            .melt_since
            .is_some_and(|t| t.elapsed().as_millis() >= super::video::MELT_REBUILD_AFTER_MS)
        {
            log::warn!("[RC] 媒体写入持续阻塞，RESET 废弃积压");
            self.discard_media_stream("sustained-write-pressure");
        }
        if self
            .video_stream_codec
            .as_deref()
            .is_some_and(|c| c != codec)
        {
            self.discard_media_stream("codec-changed");
        }
        if self.video_stream.is_some() {
            return true;
        }
        let result = tokio::time::timeout(WRITE_BUDGET, self.conn.open_uni()).await;
        let Ok(Ok(mut stream)) = result else {
            self.plane_fail_streak = self.plane_fail_streak.saturating_add(1);
            return false;
        };
        let _ = stream.set_priority(MEDIA_PRIORITY);
        if !matches!(
            tokio::time::timeout(
                WRITE_BUDGET,
                crate::rc::video::write_vhdr(&mut stream, codec)
            )
            .await,
            Ok(Ok(()))
        ) {
            discard_stream(&mut Some(stream));
            self.plane_fail_streak = self.plane_fail_streak.saturating_add(1);
            return false;
        }
        self.plane_fail_streak = 0;
        self.plane_await_idr = true;
        log::info!("[RC] 媒体发送流已建立（{codec}，stream={}）", stream.id());
        self.video_stream = Some(stream);
        self.video_stream_codec = Some(codec.to_owned());
        true
    }

    async fn media_open_failed(&mut self) -> bool {
        if self.plane_fail_streak >= 3 {
            self.svc
                .force_end_if_session(&self.my_id, "视频通道建立失败")
                .await;
            false
        } else {
            true
        }
    }

    pub(super) async fn send_via_video_plane(
        &mut self,
        p: &crate::rc::encode_h264::H264Packet,
        sq: u32,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
        codec: &str,
        started_ms: u64,
    ) -> bool {
        if !self.ensure_media_stream(codec).await {
            return self.media_open_failed().await;
        }
        if self.plane_await_idr && !p.key {
            // 编码器可能仍输出 RESET 前已缓存的 P 帧；只请求一次恢复 IDR，
            // 不能把这几帧变成连续多次强制关键帧，挤占弱网预算。
            request_key_once(&mut self.plane_key_requested, &self.force_key);
            return true;
        }
        let first = self.plane_await_idr;
        if first {
            log::info!(
                "[RC] 媒体首帧已编码（{codec}，session={}，cap={cap_ms}ms enc={enc_ms}ms）",
                self.my_id
            );
        }
        let started = std::time::Instant::now();
        let s = self.video_stream.as_mut().unwrap();
        let result = tokio::time::timeout(
            WRITE_BUDGET,
            crate::rc::video::write_h264(
                s, &p.data, p.key, p.width, p.height, ts, cap_ms, enc_ms, sq, codec,
            ),
        )
        .await;
        if matches!(result, Ok(Ok(()))) {
            self.plane_await_idr = false;
            self.plane_key_requested = false;
            self.stream_last_write_ms = started.elapsed().as_millis() as u64;
            if first {
                log::info!("[RC] 媒体首帧已入队（{codec}，{} bytes）", p.data.len());
            }
            self.svc.media_sent(&self.my_id, started_ms, ts, p.data.len());
        } else {
            // write 取消可能留下半包，绝不能在同一流继续写下一帧。
            log::warn!("[RC] 媒体帧写失败/超过 2s，RESET 后等待新关键帧");
            crate::rc::perf::bump(&crate::rc::perf::counters::STREAM_REBUILD);
            self.discard_media_stream("h264-write-failed-or-timeout");
        }
        true
    }

    pub(super) async fn send_jpeg_plane(&mut self, frame: &crate::rc::video::Encoded, started_ms: u64) -> bool {
        if !self.ensure_media_stream("jpeg").await {
            return self.media_open_failed().await;
        }
        if self.plane_await_idr && frame.rect.is_some() {
            // 新 reader 没有旧画布；下一次采集必须是完整 JPEG。
            self.enc
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reset_reference();
            return true;
        }
        let first = self.plane_await_idr;
        if first {
            log::info!(
                "[RC] 媒体首帧已编码（jpeg，session={}，cap={}ms enc={}ms）",
                self.my_id,
                frame.frame.cap_ms,
                frame.frame.enc_ms
            );
        }
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            WRITE_BUDGET,
            crate::rc::video::write_jpeg_frame(self.video_stream.as_mut().unwrap(), frame),
        )
        .await;
        if matches!(result, Ok(Ok(()))) {
            self.plane_await_idr = false;
            self.stream_last_write_ms = started.elapsed().as_millis() as u64;
            if first {
                log::info!(
                    "[RC] 媒体首帧已入队（jpeg，{} bytes）",
                    frame.frame.jpeg.len()
                );
            }
            self.svc.media_sent(&self.my_id, started_ms, frame.frame.at_ms, frame.frame.jpeg.len());
        } else {
            log::warn!("[RC] JPEG 媒体帧写失败/超过 2s，RESET 后重建");
            self.discard_media_stream("jpeg-write-failed-or-timeout");
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buffered_old_p_frames_do_not_repeat_the_idr_request() {
        let force = AtomicBool::new(false);
        let mut requested = false;
        request_key_once(&mut requested, &force);
        assert!(force.swap(false, Ordering::SeqCst)); // 编码器已经消费恢复请求。
        for _ in 0..8 { request_key_once(&mut requested, &force); }
        assert!(!force.load(Ordering::SeqCst), "旧 P 帧不应再请求一串 IDR");
        requested = false; // 下一次真正 RESET 才重新武装。
        request_key_once(&mut requested, &force);
        assert!(force.load(Ordering::SeqCst));
    }
}
