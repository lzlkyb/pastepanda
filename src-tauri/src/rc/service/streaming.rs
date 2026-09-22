//! 画质 / 码率 / 自动档 / RTT 流控（流参数与编码档位）。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// RTT 变化通知链路层（`outbound.rs` 解析出 `t:"pong"` 后调用）。
    ///
    /// 一次调用喂两个消费者：RTT 数值进 `stream`（码率自适应要用），
    /// **「收到过 pong」这个事实**进 `link`（界面判活性的唯一证据）。
    ///
    /// 🔴 `rtt_ms <= 0` **不算** pong：那是会话开始 / 结束时的清零复位
    ///   （`note_rtt(0)` 在两个收尾点被调用）。不区分的话，会话一建立
    ///   界面就报「已连接」，把真正的首包延迟掩盖掉。
    pub fn note_rtt(&self, rtt_ms: i64) {
        self.stream.note_rtt(rtt_ms);
        // ❗ `rtt_ms == 0` 是**清零复位**（`end_session` 与发起失败路径都调它），
        //    不是一次测量 —— 别把它当成「收到 pong」，否则会话一建立界面就报
        //    「已连接」，把首包延迟掩盖掉。
        if rtt_ms > 0 {
            self.link.note_pong(rtt_ms);
        }
    }

    pub fn last_rtt_ms(&self) -> i64 {
        self.stream.rtt_ms()
    }

    /// 会话建立时用本机配置初始化推流参数。
    pub fn reset_stream_opts_from_cfg(&self) {
        let cfg = self.cfg();
        self.stream.reset_from_cfg(
            profile_from_cfg(&cfg),
            virtual_screen_from_cfg(&cfg),
            auto_from_cfg(&cfg),
            codec_from_cfg(&cfg),
        );
    }

    /// 发起端配置的码率倍率（Q5）。缺省 100 = 跟随链路；配置损坏按缺省算。
    pub(crate) fn user_bitrate_pct_from_cfg(&self) -> u32 {
        self.cfg()
            .get(CFG_BITRATE_PCT)
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(100)
        .clamp(50, 200)
    }

    /// 被控端：应用发起端推来的码率倍率（Q5，`SetBitratePct`）。
    pub fn set_user_bitrate_pct(&self, pct: u32) -> Result<(), String> {
        self.stream.set_user_bitrate_pct(pct)
    }

    /// 发起端在会话中改画质（五档实名或 "auto"）。
    pub fn set_stream_quality(&self, quality: &str) -> Result<(), String> {
        // D6：fps120 / uhd60 是能力档，API 层也要设防——UI 门控（visibleQualities）
        // 只挡得住正常路径，挡不住直连接口/旧前端的请求；放行会让主机用 CPU 管线
        // 按 8ms 硬跑。范围中途切到多屏的场景由推流循环的降档兜底（D6b）。
        if quality == "fps120" {
            #[cfg(target_os = "windows")]
            {
                let caps = crate::rc::gpu::encode_caps();
                if !caps.h264_gpu {
                    return Err("本机没有硬件 D3D11 编码器，fps120 档不可用".into());
                }
                if caps.refresh_hz < 100 {
                    return Err(format!(
                        "主屏刷新 {}Hz 不足 100Hz，fps120 档不可用",
                        caps.refresh_hz
                    ));
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("fps120 档仅支持 Windows".into());
            }
        }
        // Q4：uhd60 要求 HEVC 硬编——4K60 的 H.264 需要 L5.2（多数解码端跑不动
        // 或兼容性差），HEVC L5.1 即覆盖且同画质省一半带宽。没有 HEVC MFT 就
        // 诚实拒绝，不静默降成超规格流。
        if quality == "uhd60" {
            #[cfg(target_os = "windows")]
            {
                let caps = crate::rc::gpu::encode_caps();
                if !caps.h264_gpu {
                    return Err("本机没有硬件 D3D11 编码器，4K60 档不可用".into());
                }
                if !caps.hevc_hw {
                    return Err("本机没有硬件 HEVC 编码器，4K60 档不可用（H.264 无法稳定 4K60）".into());
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("4K60 档仅支持 Windows".into());
            }
        }
        self.stream.set_quality(quality)
    }

    /// 推流循环每帧喂一次画面字节数；自动档开启时据此换档（2A）。
    pub fn auto_note_frame(&self, bytes: usize) {
        self.stream.auto_note_frame(bytes, now_ms());
    }

    /// 自动档是否开启（status 组装用）。
    pub fn auto_enabled(&self) -> bool {
        self.stream.auto_enabled()
    }

    /// 自动档当前生效的档位名。
    pub fn auto_tier_name(&self) -> String {
        self.stream.auto_tier_name()
    }

    /// 会话收尾时复位推流侧的**会话级**状态（`end_session` 调）。
    ///
    /// 目前只有自动档：它与会话同生命周期，跨会话残留会让界面显示上一场
    /// 会话停留的档位（见 `StreamCfg::auto_reset`）。
    pub(in crate::rc) fn reset_stream_after_session(&self) {
        self.stream.auto_reset();
    }

    /// 被控端：对端上报 RTT，返回当前 H.264 码率缩放（%）。
    pub fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        self.stream.set_peer_rtt(rtt_ms)
    }

    /// 被控端：QUIC stats 采样（推流任务）喂本端链路状况 → 码控（P0-4）。
    pub(in crate::rc) fn note_stream_health(&self, rtt_ms: i64, loss_permille: i64) {
        self.stream.note_stream_health(rtt_ms, loss_permille);
    }

    /// 发起端：pong 带回的时钟偏差样本（P0-1 A3）。
    pub(in crate::rc) fn note_clock_skew(&self, sample_ms: i64, rtt_ms: i64) {
        self.stream.note_clock_skew(sample_ms, rtt_ms);
    }

    pub(in crate::rc) fn clock_skew_ms(&self) -> i64 {
        self.stream.clock_skew_ms()
    }

    /// 发起端：被控端上报的画面能力（P1 caps 控制帧）。UI 据此诚实出 fps120 档。
    /// Q3：caps 带 HEVC 硬编可用性；Q7：caps 顺带带上对端在线显示器列表。
    pub(in crate::rc) fn note_peer_caps(
        &self,
        fps120: bool,
        refresh_hz: u32,
        hevc: bool,
        monitors: Vec<crate::screenshot::MonitorInfo>,
        dgram_input: bool,
    ) {
        self.peer_fps120
            .store(fps120, std::sync::atomic::Ordering::Relaxed);
        self.peer_refresh_hz
            .store(refresh_hz.min(1000), std::sync::atomic::Ordering::Relaxed);
        self.peer_hevc
            .store(hevc, std::sync::atomic::Ordering::Relaxed);
        self.peer_dgram_input
            .store(dgram_input, std::sync::atomic::Ordering::Relaxed);
        *self.peer_monitors.lock().unwrap_or_else(|p| p.into_inner()) = monitors;
    }

    pub fn peer_fps120(&self) -> bool {
        self.peer_fps120.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端视角：被控端是否支持 HEVC 硬编（Q3 caps）。
    pub fn peer_hevc(&self) -> bool {
        self.peer_hevc.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端视角：被控端 caps 是否声明可读鼠标数据报（R3）。false = 旧版。
    pub fn peer_dgram_input(&self) -> bool {
        self.peer_dgram_input.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn peer_refresh_hz(&self) -> u32 {
        self.peer_refresh_hz
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 发起端：本端丢包率采样（收流任务）→ status/HUD（P0-4）。
    pub(in crate::rc) fn note_remote_loss(&self, permille: u32) {
        self.remote_loss_permille
            .store(permille.min(1000), std::sync::atomic::Ordering::Relaxed);
    }

    pub fn bitrate_scale(&self) -> u32 {
        self.stream.bitrate_scale()
    }

    /// 发起端在会话中改截取范围。
    ///
    /// ⚠️ 这个入口**故意不发** `emit_scope_changed`：本机用户在设置页自己改范围
    /// 不该收到「有人改了你的画面范围」。只有入站路径
    /// （`handle_inbound_input` 的 `SetCaptureScope`）才通知。
    /// `rc/tests.rs` 有专门断言，搬动时别把通知顺手加进来。
    pub fn set_stream_scope(&self, scope: &str) -> Result<(), String> {
        self.stream.set_scope(scope)
    }

    /// 发起端：H.264 解不出时强制本会话走 JPEG；`codec=h264` 可再打开。
    pub fn set_stream_codec(&self, codec: &str) -> Result<(), String> {
        self.stream.set_codec(codec)
    }

    pub(in crate::rc) fn stream_opts_snapshot(&self) -> StreamOpts {
        self.stream.snapshot()
    }

    pub fn touch_activity(&self) {
        self.stream.touch_activity(now_ms());
    }

    /// 是否应暂停推流：会话开始后长时间无心跳/输入。
    pub fn should_pause_stream(&self) -> bool {
        self.stream.should_pause(now_ms())
    }

    pub fn encode_profile(&self) -> crate::rc::video::EncodeProfile {
        profile_from_cfg(&self.cfg())
    }

    pub fn capture_virtual_screen(&self) -> bool {
        virtual_screen_from_cfg(&self.cfg())
    }
}
