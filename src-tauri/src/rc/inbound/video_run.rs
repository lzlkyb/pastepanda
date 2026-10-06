//! InboundVideo 运行循环：jpeg 兜底路径与 run 主循环。

use super::*;
// 推流节拍判据（提帧上限 / 有效档位节拍 / 下一帧节拍）收口在 `rc::pace`：
// inbound.rs 的主题是会话结构与生命周期，这批是纯判据，变更理由不同。
use crate::rc::pace::{boost_gap_ms, effective_interval_ms, next_period_ms};

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
                #[cfg(target_os = "windows")]
                let media_sent = if self.peer_media_plane {
                    if !self.send_jpeg_plane(&enc_out).await { return Step::End; }
                    true
                } else { false };
                #[cfg(not(target_os = "windows"))]
                let media_sent = false;
                if !media_sent {
                    let mut guard = self.send.lock().await;
                    if crate::rc::video::write_jpeg_frame(&mut guard, &enc_out).await.is_err() {
                        drop(guard);
                        self.svc.force_end_if_session(&self.my_id, "画面推送失败").await;
                        return Step::End;
                    }
                }
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
        // G3：对端申请了系统声音 → 音频采集 + 专用流（Windows 宿主专属，mobile 无音频）
        #[cfg(target_os = "windows")]
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
            // 🔴 P1-5（2026-09-23 审计）：半开链路看门狗（被控侧）。
            //
            // 下面那条 `should_pause_stream` 只是**省带宽**（3.5s 无心跳就停推帧，
            // 心跳回来就继续），它 `continue` 掉的是整圈循环，因此旧实现里
            // 「对端进程被杀 / 拔网线 / 笔记本合盖」这种半开连接只能等
            // `SESSION_TTL_MS`（2 小时）才收口——期间横幅一直挂着「正在被控制」、
            // busy 闸一直被占。15 秒零入站证据已经不是抖动而是失联，直接收口：
            // 走 `force_end_if_session`（按 session id 认领，绝不误杀同 peer 的
            // 新会话），于是 `release_all` 补发 up、历史落库、设备标离线全部照走。
            // 🔴 后台保活（2026-10-02）：看门狗升级为 bg 感知（纯判据在
            // `link::peer_bg_watchdog`，有守卫单测）。发起端进后台（BgPause）
            // 后 WebView/进程会被冻结，心跳断是**预期内**的——按前台口径的
            // 15s 失联判死就是「切后台再回来远程就断了」的根因；后台连续
            // 无入站证据达到 5 分钟才收口，健康心跳不受后台时长限制。
            let bg_since = self.svc.peer_background_since();
            if let Some(reason) = self.svc.inbound_disconnect_reason() {
                log::info!("[RC] {reason}，自动结束会话，恢复窗口={}ms",
                    self.svc.heartbeat_timeout_ms());
                self.svc.force_end_if_session(&self.my_id, reason).await;
                break;
            }
            #[cfg(target_os = "windows")]
            if let Some(pipe) = &mut self.media_pipe {
                pipe.set_paused(self.svc.media_paused());
            }
            if bg_since > 0 {
                // 对端在后台：整圈跳过——不采集、不编码、不发送。
                // 对端前端已暂停消费（useWindowVisible），推出去只会堆在 outbox
                // 里等过期，采集+编码是纯白烧 CPU/电。BgResume 一到就强制 IDR
                // （spawn_input_reader），下一圈画面整帧恢复。
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                continue;
            }
            if self.svc.should_pause_stream() {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                continue;
            }
            // 丙-③：被控者按了「暂停对方观看」。与上面那条**省带宽**的暂停无关，
            // 这条是隐私闸：光标形状也算画面的一部分（对方屏幕上那颗指针也是本机
            // 此刻的状态），所以整圈跳过——采集、编码、发送、光标上报一概不做。
            // 🔴 会话、心跳、输入读取、剪贴板、文件通道都不受它影响：这条按钮答的是
            // 「别看我屏幕」，不是「别动我电脑」（后者是乙-③ 的收回键鼠）。
            // 空转只读一个原子量，300ms 一轮：恢复后最多半秒就重新出帧。
            if self.svc.video_paused() {
                tokio::time::sleep(std::time::Duration::from_millis(
                    crate::rc::service::video_pause::PAUSE_POLL_MS,
                ))
                .await;
                continue;
            }
            // 等待：到点（固定节奏）或 输入提帧（拖动跟手）。
            // 提帧走 `boost_frame`（notify_one，**存许可**）⇒ 本圈干活期间到达的
            // 输入不会落空。旧实现用 notify_waiters 不存许可，错过一次就要等
            // 整个档位间隔（默认 100ms），是「拖动帧率忽高忽低」的直接原因
            // （2026-09-22 修）。
            // 本圈是「输入提帧」唤醒还是「节拍到点」唤醒——决定自适应降频要不要
            // 参与（见圈末 `pace_scale` 段）。
            // 🔴 P0（2026-10-06）：问门挪到节拍**之后**。旧的阻塞式 `wait_media_capacity`
            // 挡在这段等待前面，预算一低整圈就停在闸上——节拍、提帧、光标上报全停，
            // 而控制器只看得到「交付变慢」，分不清线路窄还是我们自己断粮（自锁链的起点）。
            let mut boosted = false;
            {
                let notified = self.input_boost.notified();
                tokio::select! {
                    _ = tokio::time::sleep_until(next_tick) => {}
                    _ = notified => { boosted = true; }
                }
            }
            // 暂停必须先于问门：暂停期没有「想发而发不下」的帧，一次空转都不许记成需求
            // 证据（`note_drop` 会把 app-limited 判反，P3 会拿着假需求去翻倍预算）。
            if self.svc.media_paused() { continue; }
            // P1-6：每圈顺手比一次光标形状（GetCursorInfo 微秒级）。
            // 🔴 必须排在媒体闸**之前**：光标走控制流，跟媒体预算毫无竞争，被闸饿掉的
            // 那段时间里发起端看到的是**冻住的指针 + 旧形状**（拖动时尤其明显）。限频在
            // `cursor_should_send`（位置 40ms、形状/可见性翻转即时），闸关着空转也不会灌流。
            self.maybe_send_cursor().await;
            #[cfg(target_os = "windows")]
            if self.peer_video_plane || self.peer_media_plane {
                match self.media_gate() {
                    super::media_pipe::Gate::Open => {}
                    super::media_pipe::Gate::Drop(retry_ms) => {
                        // 本帧丢掉，但节拍照走：把锚点推到下一格。不推就等于让上面的
                        // `sleep_until` 立刻返回，本圈变成忙等——比旧的阻塞实现更糟。
                        next_tick = tokio::time::Instant::now()
                            + std::time::Duration::from_millis(retry_ms);
                        continue;
                    }
                    super::media_pipe::Gate::End => break,
                }
            }
            // 提帧限速：档位间隔与提帧上限（`BOOST_GAP_MS`=16ms）取小 ——
            // 所有档位拖动时都能到 60fps，fps120 档跟随自己的 8ms。
            // 跑不动不会更差：单圈耗时本身就决定了真实帧率（`frame_start`
            // 在超时后不再等待）。
            let opts = self.svc.stream_opts_snapshot();
            // 有效节拍（含 D6b 的 fps120 降频）收口在 `effective_interval_ms`：
            // 编码器 fps（`want_fps_for`）必须看到同一个值，否则时间戳步进与
            // 实际节拍脱节（判据写两遍必漏一处，2026-09-22 收口）。
            let interval = {
                // gpu_disabled 是 Windows 宿主字段（mobile 恒 false：无硬编可判死）
                #[cfg(target_os = "windows")]
                let gpu_disabled = self.gpu_disabled;
                #[cfg(not(target_os = "windows"))]
                let gpu_disabled = false;
                effective_interval_ms(
                    opts.profile.interval_ms,
                    opts.virtual_screen,
                    gpu_disabled,
                )
            };
            let boost_gap = std::time::Duration::from_millis(
                boost_gap_ms(interval).max(1000 / self.svc.media_fps_limit(&self.my_id) as u64));
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

            let work_start = tokio::time::Instant::now();
            // 探针：本圈起点先清暂存——两条路径各自按需覆盖，
            // 没覆盖就说明本圈空转（`produced = false`）
            self.perf_last = crate::rc::perf::FrameTiming::idle();
            self.tick_jpeg = false;
            let ended = match self.try_hardware_path(&opts).await {
                // Sleep = 本圈已推完或屏幕无变化。jpeg_path 是一次全量 GDI 截屏 +
                // 差分：H264 会话里跑它就是每圈白烧 CPU（8ms 预算装不下，直接把
                // 固定节奏拖死），画面一动还会往 H264 流里插冗余 JPEG 帧、污染
                // 自动档判据与 HUD 分段。JPEG 只服务 FallThrough（编码器不可用/
                // 单帧失败）。2026-09-19 审查 R1：节奏重做时曾把这条回归掉。
                Step::Sleep => false,
                Step::End => true,
                Step::FallThrough => {
                    // 探针：本圈实际出的是 JPEG（下面 `管线` 标签按它说话）。
                    self.tick_jpeg = true;
                    // 探针：走 JPEG 兜底说明硬编这条路这一圈没成。
                    // 只在「硬编本该可用却回退了」时才有诊断价值——
                    // 一开始就没开硬编（用户选 JPEG / 机器不支持）不算回退。
                    // 编码器回退计数只对 Windows 宿主管线有意义
                    #[cfg(target_os = "windows")]
                    if self.h264.is_some() || self.enc_retry_after.is_some() {
                        crate::rc::perf::bump(&crate::rc::perf::counters::JPEG_FALLBACK);
                    }
                    matches!(self.jpeg_path().await, Step::End)
                }
            };
            if ended {
                break;
            }
            // P1-7 自适应降频 + P4 复位：判据收口在 `rc::pace::pace_step`
            //（三条口径的来历与反例都在那儿，回归钉见 `rc/tests/pace.rs`）。
            // 圈末的「活跃」定义：本圈被输入提帧唤醒，或本圈真的产出了一帧
            // （= 桌面画面**在动**）。它只决定节拍，降频判据另说。
            let active = boosted || self.perf_last.produced;
            let loop_ms = (tokio::time::Instant::now() - work_start).as_millis() as u64;
            let (ema_ms, scale) = crate::rc::pace::pace_step(crate::rc::pace::PaceBeat {
                boosted,
                produced: self.perf_last.produced,
                work_ms: self.perf_last.cap_ms + self.perf_last.enc_ms,
                ema_ms: self.work_ema_ms,
                interval_ms: interval,
                scale: self.pace_scale,
                link_clear: crate::rc::media_flow::transport_clear(
                    self.svc.video_rtt_ms(),
                    self.svc.loss_permille(),
                ),
            });
            if scale > self.pace_scale {
                log::info!("[RC] 编码跑不满档位间隔（EMA {}/{}ms），放大到 {}x",
                    ema_ms, interval * scale as u64, scale);
            }
            self.work_ema_ms = ema_ms;
            self.pace_scale = scale;
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
            // 下一帧节拍由 `next_period_ms` 决定（判据与完整理由在 `rc::pace`）：
            // **活跃圈（画面在动 / 刚被输入提帧）→ 16ms＝60fps**，空闲圈才按
            // 档位间隔 × pace_scale。这是「窗口开关动画终于看得见」的关键——
            // 动画期间每圈都活跃，于是被以 60fps 连续抓取；旧实现只在输入
            // 事件那一瞬间提一帧，200ms 的动画总共只抓到 2 帧。
            next_tick = frame_start
                + std::time::Duration::from_millis(next_period_ms(active, interval, self.pace_scale)
                    .max(1000 / self.svc.media_fps_limit(&self.my_id) as u64));
        }
        #[cfg(target_os = "windows")]
        self.discard_media_stream();
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
