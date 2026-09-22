//! InboundVideo 构造与硬编（H.264）路径：try_new / open_h264 / try_hardware_path / send_h264_pkts。

use super::*;

impl InboundVideo {
    /// 会话存在、是入站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(in crate::rc) fn try_new(
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
            crate::rc::video::EncoderState::with_profile(profile, virt),
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
            dxgi: crate::rc::dxgi::DxgiPool::new(),
            #[cfg(target_os = "windows")]
            h264,
            #[cfg(target_os = "windows")]
            enc_fail_streak: 0,
            #[cfg(target_os = "windows")]
            enc_retry_after: None,
            #[cfg(target_os = "windows")]
            enc_retry_backoff: 5,
            #[cfg(target_os = "windows")]
            gpu_disabled: false,
            #[cfg(target_os = "windows")]
            dgram: crate::rc::vid_dgram::VidDgramSender::new(),
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
            perf: crate::rc::perf::FrameStats::new(),
            perf_last: crate::rc::perf::FrameTiming::idle(),
        })
    }

    /// R6 硬编会话：配置强制 JPEG 时不开；打不开也回 None（走 JPEG）。
    /// Q3：配置 `hevc` 时按 HEVC 打开（打不开 SessionEncoder 会话内自动回落
    /// H.264，不再整个退 JPEG）。打开尺寸跟**当前抓取范围**的物理分辨率走
    /// （会话中换范围时 `encode_bgra` 检测到尺寸变化会自己重开）。
    /// 时间戳统一按 30fps 步进：输入提帧的上限也是 30fps（BOOST_MIN_GAP），
    /// 保证时间戳单调不倒退。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn open_h264(
        svc: &Arc<RcService>,
        virt: bool,
    ) -> Option<crate::rc::encode_h264::H264SessionEncoder> {
        // Q3：编码标准统一从会话参数快照取——`reset_stream_opts_from_cfg` 已把
        // 本机配置（rc_codec）解析进去，与会话中 SetCodec 的切换同一条通路；
        // uhd60 等自带 HEVC 偏好的档位也在这里生效。
        let opts = svc.stream_opts_snapshot();
        if opts.force_jpeg() {
            return None;
        }
        let codec = if opts.profile.hevc
            || matches!(opts.codec, crate::rc::stream_cfg::StreamCodec::Hevc)
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
        let enc = crate::rc::encode_h264::H264SessionEncoder::try_open(codec, pw, ph, fps);
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
    pub(in crate::rc) async fn register_send_slot(&mut self) {
        let ib = self.send.clone();
        let svc = self.svc.clone();
        tauri::async_runtime::spawn(async move {
            *svc.inbound_send.lock().await = Some(ib);
        });
    }

    /// 探针（2026-09-21）：组装汇总行的运行时上下文——档位 / 节奏 / 实际管线。
    ///
    /// `pipeline` 取「本圈实际走的路径」而不是「期望走的路径」：
    /// `perf_last.produced` + `self.h264.is_some()` 才能区分
    /// 「H.264 出了帧」和「硬编开着但这帧其实回退了 JPEG」——后者正是
    /// 排查时要抓的（日志里 `管线 JPEG` 却挂着 `h264_gpu: true` 就是它）。
    pub(in crate::rc) fn perf_extra(
        &self,
        opts: &crate::rc::stream_cfg::StreamOpts,
        interval: u64,
    ) -> crate::rc::perf::ReportExtra {
        let pipeline = if !self.perf_last.produced {
            "空转".to_string()
        } else if self.h264.is_some() {
            // 编码标准取自编码器本体（HEVC 可能已回落 H.264）
            let std = self
                .h264
                .as_ref()
                .map(|e| e.codec().as_str().to_uppercase())
                .unwrap_or_else(|| "?".into());
            // GPU 模式不好从外面读（`gpu_mode` 私有）——但 `gpu_disabled`
            // 能区分「零拷贝可用」与「已判死回落 CPU」，够诊断用了。
            if self.gpu_disabled {
                format!("{std}-CPU（零拷贝已判死）")
            } else {
                std
            }
        } else {
            "JPEG".to_string()
        };
        let active_quality = if self.svc.auto_enabled() {
            self.svc.auto_tier_name()
        } else {
            String::new()
        };
        crate::rc::perf::ReportExtra {
            profile: crate::rc::perf::profile_name(&opts.profile),
            interval_ms: interval,
            pace_scale: self.pace_scale,
            pipeline,
            active_quality,
            pick: None,
        }
    }

    /// 收尾行的上下文。档位取自**最后一次快照**（会话参数在结束时已不可靠）。
    pub(in crate::rc) fn perf_extra_last(&self) -> crate::rc::perf::ReportExtra {
        let opts = self.svc.stream_opts_snapshot();
        let interval = opts.profile.interval_ms;
        // 收尾时 `perf_last` 可能停在最后一个空转圈 → 别让它把管线谎报成「空转」
        let mut extra = self.perf_extra(&opts, interval);
        if extra.pipeline == "空转" {
            extra.pipeline = if self.h264.is_some() {
                self.h264
                    .as_ref()
                    .map(|e| e.codec().as_str().to_uppercase())
                    .unwrap_or_else(|| "H264".into())
            } else {
                "JPEG".to_string()
            };
        }
        extra
    }

    /// R6 硬编路径：主屏 / 指定单屏 / 虚拟屏都走 DXGI + H.264；仅强制 JPEG 时回退。
    /// P1：fps120 档（interval ≤10ms）+ 单输出场景走 D3D11 零拷贝；
    /// 其余（多屏拼接 / 低档位 / GPU 路径不可用）走 CPU 管线，失败回 JPEG。
    pub(in crate::rc) async fn try_hardware_path(&mut self, opts: &crate::rc::stream_cfg::StreamOpts) -> Step {
        #[cfg(target_os = "windows")]
        {
            // 硬编熔断冷却期满 → 自动重开一次（2026-09-21）。
            // 放在入口、而不是埋在「本帧编码失败」分支里：那个分支每帧都会进，
            // 且开编码器要几百 ms，在那里重开会把推流拖垮。
            if self.h264.is_none() {
                if let Some(t) = self.enc_retry_after {
                    if std::time::Instant::now() >= t {
                        log::info!("[RC] 硬编熔断冷却期满，尝试重新启用");
                        self.h264 = Self::open_h264(&self.svc, opts.virtual_screen);
                        self.enc_fail_streak = 0;
                        self.enc_retry_after = None;
                        // 退避翻倍（上限 60s）：坏环境里别把 CPU 烧在反复重开上
                        self.enc_retry_backoff = (self.enc_retry_backoff * 2).min(60);
                    }
                }
            }
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
                || matches!(opts.codec, crate::rc::stream_cfg::StreamCodec::Hevc);
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
                        let ts = crate::rc::service::now_ms();
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
                    let ts = crate::rc::service::now_ms();
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
                            // 降级到 JPEG」高得多。
                            // ⚠️ 2026-09-21 修正：过去熔断是**整场会话永久**的
                            // （`h264 = None` 后再没机会回硬编）。但硬编失败常常是
                            // **瞬态**的（分辨率切换 / 显示器热插拔 / 全屏切换），
                            // 永久放弃等于把 7ms/帧 的硬编一路白丢到会话结束。
                            // 现改为**带冷却的自动重试**：熔断时按老做法置
                            // `h264 = None`（停止每帧重开编码器），记下冷却截止；
                            // 冷却期内稳定走 JPEG，期满自动 `open_h264` 重试一次。
                            // 退避 5s → 10s → 20s → 40s → 60s（上限），
                            // 避免在坏环境里反复重开把 CPU 烧光。
                            self.enc_fail_streak = self.enc_fail_streak.saturating_add(1);
                            if self.enc_fail_streak >= 60 {
                                if self.enc_retry_after.is_none() {
                                    log::warn!(
                                        "[RC] 硬编连续 {} 帧失败，暂停硬编走 JPEG；{}s 后自动重试：{e}",
                                        self.enc_fail_streak,
                                        self.enc_retry_backoff
                                    );
                                    self.enc_retry_after = Some(
                                        std::time::Instant::now()
                                            + std::time::Duration::from_secs(self.enc_retry_backoff),
                                    );
                                    // 真正的熔断动作：停掉每帧重开编码器
                                    self.h264 = None;
                                    // 探针：熔断次数（收尾行会带上）
                                    crate::rc::perf::bump_u32(&crate::rc::perf::counters::ENC_FUSE);
                                }
                                // 冷却是「暂停」不是「永久放弃」——但重开**不能在这里**：
                                // 本分支每帧都会进，且开编码器要几百 ms，必须等
                                // 冷却期满后再由下面的独立判断处理。
                            } else {
                                log::debug!(
                                    "[RC] 视频编码失败（第 {} 帧），本帧回退 JPEG：{e}",
                                    self.enc_fail_streak
                                );
                            }
                            Step::FallThrough
                        }
                    }
                }
                Ok(None) => Step::Sleep,
                Err(_) => {
                    // 探针：抓屏失败计数（`grab` 返回 Err 而非 Ok(None)——后者是
                    // 「屏幕没变」的正常空转，混为一谈会看不出真实故障）
                    crate::rc::perf::bump(&crate::rc::perf::counters::CAPTURE_FAIL);
                    Step::FallThrough
                }
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
    pub(in crate::rc) async fn send_h264_pkts(
        &mut self,
        pkts: Vec<crate::rc::encode_h264::H264Packet>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
    ) -> Step {
        if pkts.is_empty() {
            return Step::Sleep;
        }
        // 探针：H.264 路径出了帧。发送耗时在最后统一算——
        // 关键帧走可靠流、P 帧走数据报，两条路的 send 都要计入。
        let send_t0 = std::time::Instant::now();
        self.perf_last = crate::rc::perf::FrameTiming::produced(
            cap_ms as u64,
            enc_ms as u64,
            None, // 结尾补上真实发送耗时
        );
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
                    && since.elapsed().as_millis() as i64 > crate::rc::video::REFINE_AFTER_MS
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
                if crate::rc::video::write_h264(
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
                Err(crate::rc::vid_dgram::SendErr::Busy) => {
                    // 数据报缓冲满 = 拥塞。弃帧：接收端成洞 → corrupt → 要关键帧。
                    log::debug!("[RC] 数据报缓冲满，弃 P 帧 #{sq}（走自愈）");
                }
                Err(crate::rc::vid_dgram::SendErr::Dropped(e)) => {
                    log::debug!("[RC] P 帧分片发送中断（{e}）——接收端将走自愈");
                }
            }
        }
        // 探针：补上真实发送耗时（上面循环里两种发送方式各自计时不划算，
        // 这里统一取整段时长——诊断要的是「发送这一段占了多少预算」）
        self.perf_last.send_ms = Some(send_t0.elapsed().as_millis() as u64);
        Step::Sleep
    }
}
