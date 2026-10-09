//! Mac AVC producer reuses the bounded media plane and JPEG fallback.
use super::*;
impl InboundVideo {
    pub(super) async fn try_mac_video(&mut self, opts: &crate::rc::stream_cfg::StreamOpts) -> Step {
        if opts.force_jpeg() {
            self.mac_video
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .suspend();
            return Step::FallThrough;
        }
        if !self.peer_video_plane && !self.peer_media_plane
            || self
                .mac_video_retry
                .is_some_and(|at| std::time::Instant::now() < at)
        {
            return Step::FallThrough;
        }
        let enc = self.enc.clone();
        let native = self.mac_video.clone();
        let opts = *opts;
        let force = self.force_key.swap(false, Ordering::SeqCst);
        let fps =
            crate::rc::pace::want_fps_for(opts.profile.interval_ms, opts.virtual_screen, false);
        let requested = super::video::want_stream_codec(opts.profile.hevc, &opts.codec);
        let av1 = requested == crate::rc::video_params::VideoCodec::Av1;
        let fps = crate::rc::video_params::mac_encoder_fps(
            requested,
            fps.min(self.svc.media_fps_limit(&self.my_id)),
        );
        let budget = self
            .svc
            .media_budget_kbps(&self.my_id)
            .saturating_mul(1000)
            .clamp(100_000, 100_000_000);
        let result = tokio::task::spawn_blocking(move || {
            let ts = chrono::Utc::now().timestamp_millis();
            let start = std::time::Instant::now();
            let surface = !opts.virtual_screen || opts.monitor >= 0;
            if surface {
                enc.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .suspend_capture();
                let result = native
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .encode_screen(
                        opts.monitor,
                        opts.profile.max_w,
                        opts.profile.interval_ms < 16,
                        requested,
                        fps,
                        budget,
                        force,
                        ts,
                    )?;
                let elapsed = start.elapsed().as_millis().min(u16::MAX as u128) as u16;
                return Ok::<_, String>(result.map(|(p, c)| (p, c, 0, elapsed)));
            }
            let (w, h, bytes) = crate::rc::video::capture_mac_rgba_at_fps(
                &mut enc.lock().unwrap_or_else(|p| p.into_inner()),
                fps,
            )?;
            let cap = start.elapsed().as_millis().min(u16::MAX as u128) as u16;
            let start = std::time::Instant::now();
            let frame = image::RgbaImage::from_raw(w, h, bytes).ok_or("Mac 远控图像尺寸无效")?;
            let (width, height) = crate::rc::mac_video::surface_dimensions(
                w,
                h,
                if av1 {
                    opts.profile.max_w.min(1920)
                } else {
                    opts.profile.max_w
                },
                av1,
            );
            let frame = if (w, h) == (width, height) {
                frame
            } else {
                image::imageops::resize(
                    &frame,
                    width,
                    height,
                    image::imageops::FilterType::Triangle,
                )
            };
            let mut native = native.lock().unwrap_or_else(|p| p.into_inner());
            native.suspend_surface();
            let result = native.encode(requested, &frame, width, height, fps, budget, force, ts)?;
            Ok::<_, String>(result.map(|(packet, codec)| {
                (
                    packet,
                    codec,
                    cap,
                    start.elapsed().as_millis().min(u16::MAX as u128) as u16,
                )
            }))
        })
        .await;
        let (packet, codec, cap, encode) = match result {
            Ok(Ok(Some(result))) => result,
            Ok(Ok(None)) => return Step::Sleep,
            other => {
                log::warn!("[RC] Mac 视频编码回退 JPEG：{other:?}");
                self.mac_video_retry =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                self.mac_video
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .suspend();
                self.force_key.store(true, Ordering::SeqCst);
                return Step::FallThrough;
            }
        };
        self.mac_video_retry = None;
        self.mac_video_codec = if codec == "av1" {
            "AV1 (SVT-AV1)"
        } else if codec.starts_with("hev1.") {
            "HEVC"
        } else {
            "H.264"
        }
        .into();
        let codec = crate::rc::video_params::wire_codec_label(&codec)
            .expect("Mac encoder returns a known codec");
        self.svc.media_note_encode_width(&self.my_id, packet.width);
        self.perf_last =
            crate::rc::perf::FrameTiming::produced(u64::from(cap), u64::from(encode), None);
        self.mac_video_seq = self.mac_video_seq.wrapping_add(1);
        let at = packet.at_ms;
        if self
            .send_via_video_plane(&packet, self.mac_video_seq, at, cap, encode, codec)
            .await
        {
            Step::Sleep
        } else {
            Step::End
        }
    }
}
