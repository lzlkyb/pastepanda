//! 推流参数（画质档 / 截取范围 / 强制 JPEG）与心跳活性。
//!
//! 为什么单独一个模块：三个 `set_stream_*` 全是**纯校验 + 写字段**，但原先挂在
//! `RcService` 上——而那个类型持有 DataStore、iroh endpoint 和一堆锁，构造不出来，
//! 于是 `set_scope` 的四条分支**一条测试都没有**。采集范围是隐私面（对端能改你
//! 的画面范围），没有守门测试说不过去。搬到这里之后这些分支可以直接断言。
//!
//! **时间不进这个模块**：`touch_activity` / `should_pause` 的「现在」由调用方传入，
//! 暂停判定因此可以用假时钟精确断言，不必 sleep 或依赖机器负载。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use super::service::{CFG_CAPTURE_SCOPE, CFG_CODEC, CFG_QUALITY};

/// 心跳超时：超过这么久没有输入/心跳 ⇒ 暂停推流。
const HEARTBEAT_TIMEOUT_MS: i64 = 3_500;

/// Q3：本会话的编码标准。auto = 硬编 H.264（不可用 JPEG 兜底）；
/// jpeg = 强制 JPEG（解码端兜底）；hevc = 硬编 HEVC（打不开自动回落 H.264，
/// 再 JPEG——见 `H264SessionEncoder::on_open_fail`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StreamCodec {
    Auto,
    ForceJpeg,
    Hevc,
}

/// 会话中可被发起端改的推流参数。
///
/// 字段是 `pub(super)` 而不是私有：取流的两条循环（`spawn_outbound_video` /
/// `spawn_inbound_video`）要直接读 `monitor` / `virtual_screen` / `codec`
/// 来决定抓哪块屏、走哪条编码路径。给它们加访问器只会让那两段代码更长。
#[derive(Debug, Clone, Copy)]
pub(super) struct StreamOpts {
    pub(super) profile: super::video::EncodeProfile,
    pub(super) virtual_screen: bool,
    /// >=0 抓指定显示器；-1 跟随 virtual_screen。
    pub(super) monitor: i32,
    /// Q3：本会话编码标准（原 force_jpeg: bool）。
    pub(super) codec: StreamCodec,
}

impl StreamOpts {
    /// 强制 JPEG 路径（解码端解不出硬编码时的兜底）。
    pub(super) fn force_jpeg(&self) -> bool {
        self.codec == StreamCodec::ForceJpeg
    }
}

impl Default for StreamOpts {
    fn default() -> Self {
        Self {
            profile: super::video::EncodeProfile::default(),
            virtual_screen: true,
            monitor: -1,
            codec: StreamCodec::Auto,
        }
    }
}

/// 推流参数 + 心跳/RTT 活性状态。字段私有，只能走下面这些口子。
pub(super) struct StreamCfg {
    opts: Mutex<StreamOpts>,
    /// 被控端：最近一次收到发起端输入/心跳的时间（0 = 尚未收到）。
    last_activity_ms: AtomicI64,
    /// 发起端最近一次测得的 RTT（毫秒）；0 = 尚未测到。
    last_rtt_ms: AtomicI64,
    /// 发起端上报的 RTT（NetHint）；被控端据此缩 H.264 码率。0 = 尚未收到。
    peer_rtt_ms: AtomicI64,
    /// 被控端**本端** QUIC stats 采样：最近 RTT（ms）。0 = 尚未采样。
    path_rtt_ms: AtomicI64,
    /// 被控端本端丢包率（‰，指数平滑）。0 = 尚未采样（未采样不缩码率）。
    path_loss_permille: AtomicI64,
    /// 发起端设置的「码率倍率」（Q5，50–200，100 = 跟随链路）。
    /// 与 RTT/丢包自动缩放相乘：用户调的是天花板，弱网保护仍然有效。
    user_bitrate_pct: AtomicI64,
    /// 时钟偏差（被控端时钟 − 发起端时钟，ms，EMA）。发起端由 pong 回包里的
    /// `hts` 估算；「画面延迟」= 本地时刻 − (帧采集时刻 − 偏差)。0 = 未校准。
    clock_skew_ms: AtomicI64,
    /// 「自动」档状态（2A）：enabled 时推流循环每帧喂字节数，由 [`StreamCfg::auto_note_frame`]
    /// 决定是否换档（换档 = 直接改 `opts.profile`，推流循环下一圈自己比对套用）。
    auto: Mutex<AutoTier>,
}

/// RTT → 码率缩放百分比（25–100）。局域网 <50ms 全速；跨网逐步砍。
pub fn bitrate_scale_for_rtt(rtt_ms: i64) -> u32 {
    match rtt_ms.max(0) {
        0..=49 => 100,
        50..=99 => 80,
        100..=199 => 60,
        200..=399 => 40,
        _ => 25,
    }
}

/// 丢包率（‰）→ 码率缩放百分比。与 RTT 缩放取 min 后生效——
/// 两条弱网信号（延迟高 / 丢包多）谁更糟听谁的。
pub fn bitrate_scale_for_loss(permille: u64) -> u32 {
    match permille {
        0..=9 => 100,
        10..=19 => 80,
        20..=49 => 60,
        50..=99 => 40,
        _ => 25,
    }
}

// 画质「自动」档的判据与状态在 `auto_quality.rs`（2A）。这里只做存放与喂帧。

use super::auto_quality::{auto_decide, ladder_index_of, AutoTier, AUTO_LADDER, FRAME_WINDOW};

impl StreamCfg {
    pub(super) fn new() -> Self {
        Self {
            opts: Mutex::new(StreamOpts::default()),
            last_activity_ms: AtomicI64::new(0),
            last_rtt_ms: AtomicI64::new(0),
            peer_rtt_ms: AtomicI64::new(0),
            path_rtt_ms: AtomicI64::new(0),
            path_loss_permille: AtomicI64::new(0),
            user_bitrate_pct: AtomicI64::new(100),
            clock_skew_ms: AtomicI64::new(0),
            auto: Mutex::new(AutoTier::off()),
        }
    }

    pub(super) fn note_rtt(&self, rtt_ms: i64) {
        self.last_rtt_ms.store(rtt_ms.max(0), Ordering::Relaxed);
    }

    pub(super) fn rtt_ms(&self) -> i64 {
        self.last_rtt_ms.load(Ordering::Relaxed)
    }

    /// 被控端：记录对端上报的 RTT，并给出当前码率缩放（%）。
    pub(super) fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        let v = rtt_ms.max(0);
        self.peer_rtt_ms.store(v, Ordering::Relaxed);
        self.bitrate_scale()
    }

    pub(super) fn bitrate_scale(&self) -> u32 {
        // RTT 优先用对端上报（发起端 ping 测的更稳）；没有就用本端 stats 采样
        let peer = self.peer_rtt_ms.load(Ordering::Relaxed);
        let rtt = if peer > 0 {
            peer
        } else {
            self.path_rtt_ms.load(Ordering::Relaxed)
        };
        let loss = self.path_loss_permille.load(Ordering::Relaxed).max(0) as u64;
        let auto = bitrate_scale_for_rtt(rtt).min(bitrate_scale_for_loss(loss));
        // Q5：用户倍率与之**相乘**（50–200，100 = 不干预）。乘法而非 min：
        // 弱网把 auto 砍到 40% 时，用户 200% 得到 80%——仍受保护但确实变清晰；
        // 若取 min，200% 在弱网下毫无意义。clamp 防退化（两端乘积域 12.5–200）。
        let user = self.user_bitrate_pct.load(Ordering::Relaxed).clamp(50, 200) as u32;
        ((auto * user) / 100).clamp(10, 300)
    }

    /// 发起端设置码率倍率（Q5）。范围外拒绝——UI 滑条/下拉只出 50–200，
    /// 越界值说明对端有 bug 或被篡改，静默 clamp 会掩盖问题。
    pub(super) fn set_user_bitrate_pct(&self, pct: u32) -> Result<(), String> {
        if !(50..=200).contains(&pct) {
            return Err(format!("码率倍率只能是 50–200 的整数，得到 {pct}"));
        }
        self.user_bitrate_pct
            .store(pct as i64, Ordering::Relaxed);
        Ok(())
    }

    /// 被控端：QUIC stats 采样器（推流任务）每 500ms 喂一次本端链路状况。
    /// `loss_permille < 0` = 本窗口没有发包，不更新丢包（保留旧值）。
    pub(super) fn note_stream_health(&self, rtt_ms: i64, loss_permille: i64) {
        if rtt_ms > 0 {
            self.path_rtt_ms.store(rtt_ms, Ordering::Relaxed);
        }
        if loss_permille >= 0 {
            self.path_loss_permille
                .store(loss_permille.min(1000), Ordering::Relaxed);
        }
    }

    /// 自动档判定用的当前丢包率（‰）。
    fn loss_permille(&self) -> u64 {
        self.path_loss_permille.load(Ordering::Relaxed).max(0) as u64
    }

    /// 发起端：由 pong 估算的时钟偏差样本（被控端时钟 − 本机时钟，ms）。
    ///
    /// 口径：host 在收到 ping 的时刻打 `hts`，pong 到达本地为 `t1`，
    /// 往返 rtt 已知 ⇒ 偏差样本 = `hts − (t1 − rtt/2)`（网络对称假设）。
    /// 单样本带 ±rtt/2 抖动，做 EMA 并剔除离群（网络突刺/排队会让样本瞬间飞）；
    /// 换台对端偏差完全不同，所以会话建立时清零。
    pub(super) fn note_clock_skew(&self, sample_ms: i64, rtt_ms: i64) {
        // rtt 本身不稳时样本噪声大：>300ms 的往返先不信（弱网下宁可不校准）
        if rtt_ms <= 0 || rtt_ms > 300 {
            return;
        }
        let prev = self.clock_skew_ms.load(Ordering::Relaxed);
        // 离群剔除：EMA 已建立时，偏离超过 100ms 的样本多半是排队/重排，丢掉
        if prev != 0 && sample_ms.abs_diff(prev) > 100 {
            return;
        }
        let next = if prev == 0 { sample_ms } else { (prev * 7 + sample_ms * 3) / 10 };
        self.clock_skew_ms.store(next, Ordering::Relaxed);
    }

    pub(super) fn clock_skew_ms(&self) -> i64 {
        self.clock_skew_ms.load(Ordering::Relaxed)
    }

    /// 会话建立时用本机配置初始化推流参数（画质与范围由调用方从配置解析好后传入）。
    ///
    /// `auto`：配置里画质档是不是「自动」。是则开启自动模式并从当前档起跑
    /// （"auto" 解析出的 profile 是 balanced，起跑档就是均衡）。
    /// `codec`（Q3）：本机配置的编码标准（CFG_CODEC：auto/jpeg/h264/hevc）。
    pub(super) fn reset_from_cfg(
        &self,
        profile: super::video::EncodeProfile,
        virtual_screen: bool,
        auto: bool,
        codec: StreamCodec,
    ) {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = profile;
        g.virtual_screen = virtual_screen;
        g.monitor = -1;
        g.codec = codec;
        self.peer_rtt_ms.store(0, Ordering::Relaxed);
        // Q5：码率倍率回归「跟随链路」。发起端的偏好由它在会话建立后
        // 主动推送（outbound.rs 启动即发 SetBitratePct），被控端不该继承
        // 上一场会话留下的旧值——那可能是另一台设备设的。
        self.user_bitrate_pct.store(100, Ordering::Relaxed);
        // P0-1 B6：路径统计（本端 RTT / 丢包）是**上一场会话**的采样残留，
        // 新会话第一拍采样到来之前不该拿旧值缩码率、判链路好坏。
        self.path_rtt_ms.store(0, Ordering::Relaxed);
        self.path_loss_permille.store(0, Ordering::Relaxed);
        self.clock_skew_ms.store(0, Ordering::Relaxed);
        let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        a.enabled = auto;
        a.tier = ladder_index_of(&profile).unwrap_or(1);
        a.last_change_ms = 0;
        a.high_since = None;
        a.low_since = None;
        a.recent.clear();
    }

    /// 发起端在会话中改画质。
    ///
    /// "auto" = 打开被控端的自动换档（2A）；五档实名 = 锁定并关掉自动。
    pub(super) fn set_quality(&self, quality: &str) -> Result<(), String> {
        if quality == "auto" {
            // 从当前档起跑，别凭空跳回均衡——会话中开自动不该先抖一下画面
            let cur_tier = {
                let g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
                ladder_index_of(&g.profile).unwrap_or(1)
            };
            let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
            a.tier = cur_tier;
            a.enabled = true;
            a.last_change_ms = 0;
            a.high_since = None;
            a.low_since = None;
            a.recent.clear();
            return Ok(());
        }
        if !matches!(
            quality,
            "uhd" | "uhd60" | "ultra" | "sharp" | "balanced" | "smooth" | "fps60" | "fps120"
        ) {
            return Err(
                "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120"
                    .into(),
            );
        }
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = super::video::EncodeProfile::of_name(quality);
        // 实名档 = 用户（或发起端）明确锁定，自动让位
        self.auto.lock().unwrap_or_else(|p| p.into_inner()).enabled = false;
        Ok(())
    }

    /// 推流循环每帧喂一次 JPEG 字节数。自动档开启时据此（+ 对端 RTT）决定是否换档。
    ///
    /// 返回是否换了档（调用方只拿它做日志；真正的生效靠 `opts.profile` 被改掉后，
    /// 推流循环下一圈 `stream_opts_snapshot` 比对时自己套用——零新信令）。
    pub(super) fn auto_note_frame(&self, bytes: usize, now_ms: i64) -> bool {
        let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        if !a.enabled {
            return false;
        }
        a.recent.push(bytes);
        if a.recent.len() < FRAME_WINDOW {
            return false;
        }
        let avg: usize = a.recent.iter().sum::<usize>() / a.recent.len();
        a.recent.clear();
        // 与 bitrate_scale 同口径：peer 上报优先，旧对端不发 ping 时退本端
        // stats 采样——两套判据曾各看各的（码率在缩、自动档对链路一无所知）。
        let peer_rtt = self.peer_rtt_ms.load(Ordering::Relaxed);
        let rtt = if peer_rtt > 0 {
            peer_rtt
        } else {
            self.path_rtt_ms.load(Ordering::Relaxed)
        };
        let (new_tier, high, low) = auto_decide(
            a.tier,
            rtt,
            avg,
            self.loss_permille(),
            a.high_since,
            a.low_since,
            a.last_change_ms,
            now_ms,
        );
        a.high_since = high;
        a.low_since = low;
        let Some(t) = new_tier else {
            return false;
        };
        a.tier = t;
        a.last_change_ms = now_ms;
        let name = AUTO_LADDER[t];
        // 🔴 锁序：必须先放掉 `auto` 再取 `opts`。
        //    `set_quality` / `reset_from_cfg` 走的是 opts → auto，而本函数由
        //    **推流任务**调用（inbound.rs 每帧）、那两个由**输入读取任务**调用
        //    （inbound.rs 的 spawn_input_reader），两条链路真并发 ——
        //    同向取锁就是 ABBA 死锁（设计审查抓到的阻塞项）。
        drop(a);
        self.opts.lock().unwrap_or_else(|p| p.into_inner()).profile =
            super::video::EncodeProfile::of_name(name);
        log::info!("[RC] 自动画质：链路 rtt={rtt}ms 近帧均值 {avg}B → 切到「{name}」");
        true
    }

    /// 自动档是否开启（status 组装用）。
    pub(super) fn auto_enabled(&self) -> bool {
        self.auto.lock().unwrap_or_else(|p| p.into_inner()).enabled
    }

    /// 自动档当前生效的档位名（仅 auto_enabled 时有意义）。
    pub(super) fn auto_tier_name(&self) -> String {
        let a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        AUTO_LADDER[a.tier].to_string()
    }

    /// 会话收尾：自动档状态整体复位。
    ///
    /// 不复位的话，会话结束后 `status()` 仍会报「生效档 = 流畅」这种**陈旧档位**：
    /// `enabled` 留在 true、`tier` 停在会话最后一档，而实际早就没有推流了。
    /// 复位成 `AutoTier::off()`（与新建时的初态单源），下一会话由
    /// `reset_from_cfg` 按配置重新点亮。
    pub(super) fn auto_reset(&self) {
        *self.auto.lock().unwrap_or_else(|p| p.into_inner()) = AutoTier::off();
    }

    /// 发起端在会话中改截取范围。
    pub(super) fn set_scope(&self, scope: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        if scope == "virtual" {
            g.virtual_screen = true;
            g.monitor = -1;
            return Ok(());
        }
        if scope == "primary" {
            g.virtual_screen = false;
            g.monitor = -1;
            return Ok(());
        }
        if let Some(n) = scope.strip_prefix("monitor:") {
            let idx: i32 = n
                .parse()
                .map_err(|_| "显示器编号无效，应为 monitor:0 / monitor:1…")?;
            if idx < 0 {
                return Err("显示器编号不能为负".into());
            }
            g.virtual_screen = false;
            g.monitor = idx;
            return Ok(());
        }
        Err("截取范围只能是 virtual / primary / monitor:N".into())
    }

    /// 发起端：H.264 解不出时强制本会话走 JPEG；`codec=h264` 可再打开；
    /// Q3：`hevc` 切硬编 HEVC（打不开被控端自动回落 H.264）。
    pub(super) fn set_codec(&self, codec: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        match codec {
            "jpeg" => {
                g.codec = StreamCodec::ForceJpeg;
                Ok(())
            }
            "h264" => {
                g.codec = StreamCodec::Auto;
                Ok(())
            }
            "hevc" => {
                g.codec = StreamCodec::Hevc;
                Ok(())
            }
            _ => Err("编码只能是 jpeg / h264 / hevc".into()),
        }
    }

    pub(super) fn snapshot(&self) -> StreamOpts {
        *self.opts.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn touch_activity(&self, now_ms: i64) {
        self.last_activity_ms.store(now_ms, Ordering::Relaxed);
    }

    /// 是否应暂停推流：会话开始后长时间无心跳/输入。
    pub(super) fn should_pause(&self, now_ms: i64) -> bool {
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        if last == 0 {
            // 尚未收到任何输入：给发起端 5s 窗口发首个心跳
            return false;
        }
        now_ms - last > HEARTBEAT_TIMEOUT_MS
    }
}

/// 从配置里解析画质档。抽成自由函数是为了能直接单测默认值与非法值的回落。
///
/// 缺省 = "auto"（2A 起默认自动）；"auto" 本身解析成 balanced 的编码参数起跑，
/// 自动模式由 `reset_from_cfg` 的 `auto` 参数单独打开。
pub(super) fn profile_from_cfg(cfg: &serde_json::Value) -> super::video::EncodeProfile {
    super::video::EncodeProfile::of_name(
        cfg.get(CFG_QUALITY)
            .and_then(|v| v.as_str())
            .unwrap_or("auto"),
    )
}

/// 配置里的画质档是不是「自动」。
pub(super) fn auto_from_cfg(cfg: &serde_json::Value) -> bool {
    cfg.get(CFG_QUALITY)
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        == "auto"
}

/// 从配置里解析「是否抓整个虚拟屏」。只有显式 `primary` 才算否，其余（含缺省）都抓整屏。
pub(super) fn virtual_screen_from_cfg(cfg: &serde_json::Value) -> bool {
    cfg.get(CFG_CAPTURE_SCOPE)
        .and_then(|v| v.as_str())
        .map(|s| s != "primary")
        .unwrap_or(true)
}

/// Q3：配置里的编码标准 → 会话初值。`h264` 与 `auto` 同义（缺省）；
/// `hevc` 走硬编 HEVC（打不开被控端会话内自动回落 H.264）。
pub(super) fn codec_from_cfg(cfg: &serde_json::Value) -> StreamCodec {
    match cfg
        .get(CFG_CODEC)
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
    {
        "jpeg" => StreamCodec::ForceJpeg,
        "hevc" => StreamCodec::Hevc,
        _ => StreamCodec::Auto,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c() -> StreamCfg {
        StreamCfg::new()
    }

    #[test]
    fn 范围_virtual_抓整屏() {
        let s = c();
        s.set_scope("virtual").expect("virtual 合法");
        let o = s.snapshot();
        assert!(o.virtual_screen);
        assert_eq!(o.monitor, -1);
    }

    #[test]
    fn 范围_primary_抓主屏() {
        let s = c();
        s.set_scope("primary").expect("primary 合法");
        let o = s.snapshot();
        assert!(!o.virtual_screen);
        assert_eq!(o.monitor, -1);
    }

    #[test]
    fn 范围_monitor编号合法时落到具体显示器() {
        let s = c();
        s.set_scope("monitor:1").expect("monitor:1 合法");
        let o = s.snapshot();
        assert!(!o.virtual_screen, "指定显示器就不该再走整屏");
        assert_eq!(o.monitor, 1);
    }

    #[test]
    fn 范围_monitor负号被拒且不改状态() {
        let s = c();
        s.set_scope("monitor:0").expect("先设一个合法值");
        let err = s.set_scope("monitor:-1").expect_err("负数必须被拒");
        assert_eq!(err, "显示器编号不能为负");
        assert_eq!(s.snapshot().monitor, 0, "被拒就不能留下半截改动");
    }

    #[test]
    fn 范围_monitor非数字被拒() {
        let s = c();
        let err = s.set_scope("monitor:x").expect_err("非数字必须被拒");
        assert_eq!(err, "显示器编号无效，应为 monitor:0 / monitor:1…");
    }

    #[test]
    fn 范围_乱字符串被拒() {
        let s = c();
        assert!(s.set_scope("").is_err());
        assert!(s.set_scope("Monitor:0").is_err(), "大小写敏感，不做兜底");
        assert!(s.set_scope("all").is_err());
    }

    #[test]
    fn 画质五档加auto合法其余被拒() {
        let s = c();
        for q in ["uhd", "uhd60", "ultra", "sharp", "balanced", "smooth", "auto"] {
            assert!(s.set_quality(q).is_ok(), "{q} 应合法");
        }
        let err = s.set_quality("4k").expect_err("未定义的档位必须被拒");
        assert_eq!(
            err,
            "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120"
        );
    }

    #[test]
    fn 编码只认_jpeg_h264_hevc() {
        let s = c();
        assert!(s.set_codec("jpeg").is_ok());
        assert!(s.snapshot().force_jpeg(), "jpeg ⇒ 强制本会话走 JPEG");
        assert!(s.set_codec("h264").is_ok());
        assert!(!s.snapshot().force_jpeg(), "h264 ⇒ 放开 H.264");
        assert!(s.set_codec("hevc").is_ok());
        assert_eq!(
            s.snapshot().codec,
            StreamCodec::Hevc,
            "hevc ⇒ 硬编 HEVC（打不开自动回落 H.264）"
        );
        let err = s.set_codec("vp9").expect_err("只认三种编码");
        assert_eq!(err, "编码只能是 jpeg / h264 / hevc");
    }

    #[test]
    fn 没收到过任何输入时不暂停() {
        let s = c();
        // 会话刚开始，last_activity 还是 0：不管「现在」多大都不该暂停，
        // 否则首个心跳还没到就被判死。
        assert!(!s.should_pause(1_700_000_000_000));
    }

    #[test]
    fn 超过心跳超时才暂停() {
        let s = c();
        s.touch_activity(1_000);
        assert!(!s.should_pause(1_000 + 3_500), "正好等于阈值不算超时");
        assert!(s.should_pause(1_000 + 3_501), "超出 1ms 就该暂停");
        s.touch_activity(1_000 + 3_501);
        assert!(!s.should_pause(1_000 + 3_501), "刷新活跃后立刻恢复");
    }

    #[test]
    fn rtt_负数归零() {
        let s = c();
        s.note_rtt(-5);
        assert_eq!(s.rtt_ms(), 0);
        s.note_rtt(37);
        assert_eq!(s.rtt_ms(), 37);
    }

    #[test]
    fn loss_码率缩放分档() {
        assert_eq!(bitrate_scale_for_loss(0), 100);
        assert_eq!(bitrate_scale_for_loss(9), 100);
        assert_eq!(bitrate_scale_for_loss(15), 80);
        assert_eq!(bitrate_scale_for_loss(30), 60);
        assert_eq!(bitrate_scale_for_loss(70), 40);
        assert_eq!(bitrate_scale_for_loss(200), 25);
        // RTT 满速但丢包高 → 取更差的那条
        let s = c();
        s.set_peer_rtt(10);
        s.note_stream_health(10, 60);
        assert_eq!(s.bitrate_scale(), 40);
        // 只有 RTT 时不受 loss 影响（未采样 = 0 = 满速）
        let s2 = c();
        s2.set_peer_rtt(300);
        assert_eq!(s2.bitrate_scale(), 40, "rtt 200~399 档 = 40%");
    }

    #[test]
    fn rtt_码率缩放分档() {
        assert_eq!(bitrate_scale_for_rtt(0), 100);
        assert_eq!(bitrate_scale_for_rtt(30), 100);
        assert_eq!(bitrate_scale_for_rtt(80), 80);
        assert_eq!(bitrate_scale_for_rtt(150), 60);
        assert_eq!(bitrate_scale_for_rtt(250), 40);
        assert_eq!(bitrate_scale_for_rtt(800), 25);
        let s = c();
        assert_eq!(s.set_peer_rtt(200), 40);
        assert_eq!(s.bitrate_scale(), 40);
    }

    #[test]
    fn 码率倍率与自动缩放相乘_越界被拒() {
        let s = c();
        // 默认 100：与既有行为完全一致（不干预）
        assert_eq!(s.set_peer_rtt(300), 40);
        assert_eq!(s.bitrate_scale(), 40);
        // 乘法语义：弱网 40% × 用户 200% = 80%（抬天花板但仍在保护内）
        s.set_user_bitrate_pct(200).expect("合法");
        assert_eq!(s.bitrate_scale(), 80);
        // 局域网满速 × 50% = 省带宽一半
        s.set_peer_rtt(10);
        s.note_stream_health(10, -1);
        s.set_user_bitrate_pct(50).expect("合法");
        assert_eq!(s.bitrate_scale(), 50);
        // 越界拒绝且不改状态
        assert!(s.set_user_bitrate_pct(49).is_err());
        assert!(s.set_user_bitrate_pct(201).is_err());
        assert_eq!(s.bitrate_scale(), 50, "被拒就不能留下半截改动");
        // 新会话复位：上一场的用户倍率不带走
        s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto);
        s.set_peer_rtt(300);
        assert_eq!(s.bitrate_scale(), 40, "复位后回到纯自动缩放");
    }

    #[test]
    fn 会话初始化会重置推流参数() {
        let s = c();
        s.set_scope("primary").expect("合法");
        s.set_codec("jpeg").expect("合法");
        s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto);
        let o = s.snapshot();
        assert!(o.virtual_screen, "由配置决定");
        assert_eq!(o.monitor, -1);
        assert!(!o.force_jpeg(), "新会话不该继承上一会话的强制 JPEG");
    }

    #[test]
    fn 配置缺省时画质回落自动_范围抓整屏() {
        let empty = serde_json::json!({});
        assert!(virtual_screen_from_cfg(&empty), "缺省就是抓整屏");
        assert_eq!(
            profile_from_cfg(&empty),
            super::super::video::EncodeProfile::of_name("balanced"),
            "auto 解析成 balanced 的编码参数起跑"
        );
        assert!(auto_from_cfg(&empty), "缺省档就是自动");
    }

    #[test]
    fn 配置里写了_primary_才不抓整屏() {
        assert!(!virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "primary" })
        ));
        assert!(virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "virtual" })
        ));
        assert!(virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "monitor:1" })
        ));
    }

    /// 🔴 锁序回归（设计审查抓到的阻塞项）：
    /// `auto_note_frame` 由**推流任务**每帧调用、`set_quality` 由**输入读取任务**
    /// 调用，两条链路真并发。两者的 `opts` / `auto` 取锁顺序必须一致，
    /// 否则就是 ABBA 死锁。锁序被改回去时，这条测试会**卡到超时**而不是给出
    /// 漂亮的红——那正是死锁的形状，别把它当成机器慢。
    #[test]
    fn 自动判档与改档并发不死锁() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let s = Arc::new(StreamCfg::new());
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(300);

        let w = {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                for i in 0..4_000i64 {
                    s.auto_note_frame(400_000, 1_758_000_000_000 + i);
                }
            })
        };
        let q = {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                for _ in 0..4_000 {
                    // 与 auto_note_frame 抢同一对锁，且方向相反（opts → auto）
                    s.set_quality("sharp").expect("合法");
                    s.set_quality("auto").expect("合法");
                }
            })
        };

        let deadline = Instant::now() + Duration::from_secs(30);
        while !w.is_finished() || !q.is_finished() {
            assert!(
                Instant::now() < deadline,
                "两个任务在 30s 内没跑完 → opts/auto 的取锁顺序不一致（ABBA 死锁）"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        w.join().expect("推流侧线程");
        q.join().expect("输入侧线程");
    }

    /// 会话收尾必须复位自动档：`enabled` 留在 true、`tier` 停在末档的话，
    /// `status()` 会在会话结束后继续报「生效档 = 流畅」这种不存在的档位。
    #[test]
    fn 会话收尾复位自动档() {
        let s = c();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(300);
        for i in 0..24i64 {
            s.auto_note_frame(10_000, 1_758_000_000_000 + i * 1000);
        }
        assert_eq!(s.auto_tier_name(), "smooth", "先降到低档，制造待复位的残留");
        assert!(s.auto_enabled());

        s.auto_reset();
        assert!(!s.auto_enabled(), "复位后自动档必须关掉");
        assert_eq!(
            s.auto_tier_name(),
            "balanced",
            "档位回到初态（AutoTier::off），不留上一场的痕迹"
        );
    }
}
