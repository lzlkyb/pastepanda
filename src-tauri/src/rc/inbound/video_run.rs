//! InboundVideo 运行循环：jpeg 兜底路径与 run 主循环。

use super::*;

impl InboundVideo {
    /// JPEG 路径：阻塞截帧+编码丢进 spawn_blocking，写脏矩形元数据 + JPEG。
    /// 写失败 = 对端/链路没了，收口退出。节奏（sleep）由 run() 的固定节拍管，
    /// 这里不再自己睡——旧实现「干完活再睡 interval」是拖动卡顿的元凶之一。
    pub(in crate::rc) async fn jpeg_path(&mut self) -> Step {
        let enc = self.enc.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut st = enc.lock().unwrap_or_else(|p| p.into_inner());
            crate::rc::video::capture_and_encode(&mut st)
        })
        .await;
        match result {
            Ok(Ok(enc_out)) => {
                if enc_out.frame.jpeg.is_empty() {
                    return Step::Sleep;
                }
                // 探针：JPEG 路径出了帧。`cap/enc` 由 `capture_and_encode` 自带
                //（与它写给对端 HUD 的是同一组数——两侧口径天然一致，不会出现
                // 「日志说 30ms、HUD 说 80ms」这种自相矛盾）
                let send_t0 = std::time::Instant::now();
                let mut guard = self.send.lock().await;
                if let Some(r) = enc_out.rect {
                    if let Err(e) = crate::rc::video::write_dirty_meta(&mut guard, r).await {
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
                if let Err(e) = crate::rc::video::write_vts_meta(
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
                if crate::rc::video::write_jpeg(&mut guard, &enc_out.frame.jpeg)
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
                // 探针：JPEG 路径的分段耗时（抓屏+编码来自 capture_and_encode，
                // 发送取上面三次 write 的合计）
                self.perf_last = crate::rc::perf::FrameTiming::produced(
                    enc_out.frame.cap_ms as u64,
                    enc_out.frame.enc_ms as u64,
                    Some(send_t0.elapsed().as_millis() as u64),
                );
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

    pub(in crate::rc) async fn run(mut self, recv: iroh::endpoint::RecvStream) {
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
        // 探针（2026-09-21）：会话开始先报一条，说明探针活着 + 怎么关。
        // 没有这条的话，日志里没出现 `[RC-PERF]` 会分不清是「探针没生效」
        // 还是「还没到 5s 间隔」。
        crate::rc::perf::log_startup_hint();
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
            // 探针：本圈起点先清暂存——两条路径各自按需覆盖，
            // 没覆盖就说明本圈空转（`produced = false`）
            self.perf_last = crate::rc::perf::FrameTiming::idle();
            let ended = match self.try_hardware_path(&opts).await {
                // Sleep = 本圈已推完或屏幕无变化。jpeg_path 是一次全量 GDI 截屏 +
                // 差分：H264 会话里跑它就是每圈白烧 CPU（8ms 预算装不下，直接把
                // 固定节奏拖死），画面一动还会往 H264 流里插冗余 JPEG 帧、污染
                // 自动档判据与 HUD 分段。JPEG 只服务 FallThrough（编码器不可用/
                // 单帧失败）。2026-09-19 审查 R1：节奏重做时曾把这条回归掉。
                Step::Sleep => false,
                Step::End => true,
                Step::FallThrough => {
                    // 探针：走 JPEG 兜底说明硬编这条路这一圈没成。
                    // 只在「硬编本该可用却回退了」时才有诊断价值——
                    // 一开始就没开硬编（用户选 JPEG / 机器不支持）不算回退。
                    if self.h264.is_some() || self.enc_retry_after.is_some() {
                        crate::rc::perf::bump(&crate::rc::perf::counters::JPEG_FALLBACK);
                    }
                    matches!(self.jpeg_path().await, Step::End)
                }
            };
            if ended {
                break;
            }
            // P1-7 自适应降频：单圈工作量持续贴着当前间隔跑 → 放大间隔；
            // 富余出来再缩回。EMA 平滑 + 2x/4x 判据，避免来回抖。
            let loop_ms = (tokio::time::Instant::now() - work_start).as_millis() as u64;
            let work_ms = loop_ms;
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
            // ── 诊断探针（2026-09-21）：喂本圈采样 + 到期输出汇总 ──
            // 只在**真的出了一帧**时计入分段均值：空转圈（屏幕未变化）的
            // cap/enc 几乎为 0，混进去会把「慢在编码」的真实信号稀释掉。
            // 空转仍要让 `report` 有机会触发（否则静止画面时日志一片空白）。
            {
                let t = self.perf_last;
                if t.produced {
                    self.perf.note_frame(t.cap_ms, t.enc_ms, t.send_ms, loop_ms);
                }
                if let Some(line) = self.perf.report(self.perf_extra(&opts, interval)) {
                    log::info!("{line}");
                }
            }
            // 下一帧锚在「本帧开始 + 档位间隔×降频倍数」：固定节奏，不受编码耗时影响
            next_tick = frame_start + std::time::Duration::from_millis(scaled);
        }
        // 探针（2026-09-21）：会话收尾无条件打一条全量摘要。
        // 周期性汇总会随退出丢掉最后一截（不足 5s 的部分），而那一截往往
        // 正是「刚改完设置重启会话」的现场。
        if let Some(line) = self.perf.summary(self.perf_extra_last()) {
            log::info!("{line}");
        }
        log::info!("[RC] 被控推流已停止");
        // 先比对 id 再清槽位——新会话建立时会直接覆盖 inbound_send，不清不会漏，
        // 但不比对会让旧任务清掉新会话的发送半流。
        if self.svc.session_id_is(&self.my_id) {
            *self.svc.inbound_send.lock().await = None;
        }
    }
}
