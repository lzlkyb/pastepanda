//! 会话级编码器封装（H264SessionEncoder：档位/码率协商）。

use super::*;

/// 🔴 再审计 B5（2026-09-25）：码率缩放变更的**时间冷却**。15 个百分点的
/// 差值迟滞挡不住档位边界抖动（RTT 在 50%↔60%↔50% 来回跳时每次都跨过
/// 阈值），而每次变更都是一次全链重开（几百 ms）。2s 内的第二次变更直接忽略。
const SCALE_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);
/// 剧变豁免线：差值 ≥50 个百分点不设冷却——紧急降码率（拥塞突增/断网前兆）
/// 必须立即生效，多等 2s 就是多 2s 的拥塞弃帧。
const SCALE_JUMP_PCT: u32 = 50;
/// 2026-09-28 稳定窗口：新码率值须**连续稳住这么久**才提交重开。真机复盘：
/// 帧龄排队分段加入后，拖动中 EMA 在 90/180/300ms 边界来回弹（scale
/// 100↔70↔45），15pp 迟滞 + 2s 冷却挡不住「每 2~3s 一次重开」——每次重开
/// ~1s，正是用户看到的「偶发卡顿」。弹回旧值即重置计时；稳住才放行。
const SCALE_HOLD: std::time::Duration = std::time::Duration::from_secs(3);

/// [`apply_bitrate_scale`] 的纯判断半（无环境可单测，见项目规则 11.1）：
/// 距上次变更不足冷却期时放行吗？`last=None`（从未变更过）恒放行；
/// 剧变（`diff ≥ SCALE_JUMP_PCT`）恒放行；其余在冷却期内拦截。
fn scale_change_allowed(last: Option<std::time::Instant>, now: std::time::Instant, diff: u32) -> bool {
    match last {
        None => true,
        Some(t) => {
            if diff >= SCALE_JUMP_PCT {
                return true;
            }
            now.duration_since(t) >= SCALE_COOLDOWN
        }
    }
}

/// [`apply_bitrate_scale`] 的稳定窗口半（纯函数，规则 11.1）：候选值稳够
/// [`SCALE_HOLD`] 了吗？剧变（diff ≥ [`SCALE_JUMP_PCT`]）恒豁免。
fn scale_hold_satisfied(candidate_since: std::time::Instant, now: std::time::Instant, diff: u32) -> bool {
    diff >= SCALE_JUMP_PCT || now.duration_since(candidate_since) >= SCALE_HOLD
}

/// 会话包装：open 失败则标记不可用，调用方走 JPEG。
///
/// P1：CPU（内存 NV12）与 GPU（D3D11 零拷贝）双模。码率变化不再立刻重开，
/// 统一记为「待重开」，下一次编码时（CPU/GPU 各自带上下文）执行——
/// GPU 重开需要 D3D 设备，只有 encode_gpu 时刻才有。
pub struct H264SessionEncoder {
    pub(in crate::rc) enc: Option<Backend>,
    /// Q3：目标流标准。变化触发重开；HEVC 连续打不开自动回落 H.264
    /// （HEVC 只是优化档，不能像 GPU 故障那样整个会话降 JPEG）。
    pub(in crate::rc) codec: VideoCodec,
    /// 当前码率缩放百分比（25–100），由 RTT 自适应写入。
    pub(in crate::rc) scale_pct: u32,
    /// 🔴 **30fps 标定的宽度基准码率**（bit/s）。帧率抬升与自动缩放统一在
    /// [`Self::scaled_bitrate`] 里乘——这里绝不能存已含帧率因子的值，
    /// 否则重开时帧率因子被乘第二次（1080p120 重开后 20.8Mbps → 54Mbps，
    /// 2026-09-19 审查发现的 P1）。
    pub(in crate::rc) base_bitrate: u32,
    /// 时间戳步进用的 fps（fps120 档 120、fps60 档 60、其余 30）。
    pub(in crate::rc) fps: u32,
    /// true = 当前编码器处于 D3D11 零拷贝模式。
    pub(in crate::rc) gpu_mode: bool,
    /// 模式/码率/fps 变化后待重开（下次编码时执行）。
    pub(in crate::rc) reopen_needed: bool,
    /// GPU 打开连续失败次数（≥3 判定本机零拷贝不可用，不再尝试）。
    pub(in crate::rc) gpu_fail_streak: u32,
    /// Q3：HEVC 打开连续失败次数（≥2 判定本机 HEVC 不可用，回落 H.264）。
    pub(in crate::rc) hevc_fail_streak: u32,
    /// Q3：本会话已证实 HEVC 不可用（回落过）。置位后 SetCodec hevc 不再
    /// 触发重开——否则每帧「切 HEVC → 打不开 → 回 H.264」来回翻烧饼，
    /// 隔帧掉 JPEG。
    pub(in crate::rc) hevc_broken: bool,
    /// P2-8：CPU 路径 NV12 输出缓冲（跨帧复用，尺寸变化时 resize 自适应）。
    pub(in crate::rc) nv12_buf: Vec<u8>,
    pub(in crate::rc) scaler: super::scale::BgraScaler,
    pub(in crate::rc) cpu_perf: super::scale::CpuPerf,
    /// 🔴 再审计 B5（2026-09-25）：上次码率缩放变更生效的时刻（None = 本会话
    /// 还没变过）。配合 [`SCALE_COOLDOWN`] 挡 RTT 档位边界抖动——判据见
    /// [`scale_change_allowed`]，时间语义与拦截口径都收在那一个函数里。
    pub(in crate::rc) last_scale_change: Option<std::time::Instant>,
    /// 2026-09-28 稳定窗口的候选值（值, 首见时刻）。换值即重置——来回弹
    /// 永远提交不了，稳住 3s 才真正触发重开。
    pub(in crate::rc) pending_scale: Option<(u32, std::time::Instant)>,
    pub(in crate::rc) budget_bps: Option<u32>,
    pub(in crate::rc) pending_budget: Option<(u32, std::time::Instant)>,
    pub(in crate::rc) resolution_limit: u32,
    pub(in crate::rc) capture_times: std::collections::VecDeque<i64>,
    pub(in crate::rc) next_capture_at: i64,
}

// windows-rs COM 指针非 Send；本进程 MTA + 会话任务串行访问。
// FF 后端同理（FF 句柄常驻、编码器对象串行访问）。
unsafe impl Send for H264SessionEncoder {}
unsafe impl Send for MfH264Encoder {}

/// 视频硬编后端。**回落链在 [`Self::open_chain`]**：
/// H264 = MF → FF(nvenc→qsv→amf)；HEVC = MF → FF(hevc_nvenc→hevc_qsv→hevc_amf)。
///
/// 🔴 范围（方案 A+，批 1/2）：FF 只接 CPU NV12 路径 —— `gpu_mode` 恒 false，
/// GPU 零拷贝仍是 MF 专属（hwaccel FFI 未探明，见 docs §7.2 批 3）。
pub(in crate::rc) enum Backend {
    Mf(MfH264Encoder),
    Ff(FfEncoder),
}

impl Backend {
    fn set_bitrate(&mut self, bps: u32) -> bool {
        match self { Self::Mf(e) => e.set_bitrate(bps), Self::Ff(e) => e.set_bitrate(bps) }
    }
    fn size(&self) -> (u32, u32) {
        match self {
            Backend::Mf(e) => e.size(),
            Backend::Ff(e) => e.size(),
        }
    }

    fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Vec<H264Packet>, String> {
        match self {
            Backend::Mf(e) => e.encode_nv12(nv12),
            Backend::Ff(e) => e.encode_nv12(nv12),
        }
    }

    fn force_key(&self) -> bool {
        match self {
            Backend::Mf(e) => e.force_key(),
            Backend::Ff(e) => e.force_key(),
        }
    }

    /// GPU 纹理路径仅 MF 存在。当前实现下不可达：encode_gpu 每次先走
    /// open_gpu（MF），成功则 backend 必为 Mf；连续失败 3 次已熔断返回。
    /// 留一个防御性 Err 分支兜住「未来有人改重开逻辑忘了这条不变量」。
    fn encode_texture(
        &mut self,
        bgra: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> Result<Vec<H264Packet>, String> {
        match self {
            Backend::Mf(e) => e.encode_texture(bgra, w, h),
            Backend::Ff(_) => Err("[ff] FF 后端无 GPU 零拷贝路径（不应可达）".into()),
        }
    }
}

/// 打开回落链。H264 与 HEVC 同构：MF 失败 → FF 三候选（批 2 起 HEVC 也有
/// FF 兜底，DLL 已编入 hevc_nvenc/hevc_qsv/hevc_amf）。
/// HEVC→H264 的会话级回落语义在调用方（`try_open_with_scale` / `on_open_fail`），
/// 那里把目标标准改成 H264 后重走本函数。
fn open_chain(
    codec: VideoCodec,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<Backend, String> {
    // P2.3：MF 无 AV1——直接走 FF 候选链（av1_nvenc/qsv/amf）。
    if codec == VideoCodec::Av1 {
        return FfEncoder::open(codec, width, height, fps, bitrate).map(Backend::Ff);
    }
    match MfH264Encoder::open(codec, width, height, fps, bitrate) {
        Ok(e) => Ok(Backend::Mf(e)),
        Err(mf_err) => match FfEncoder::open(codec, width, height, fps, bitrate) {
            Ok(e) => Ok(Backend::Ff(e)),
            Err(ff_err) => Err(format!("MF：{mf_err}；FF：{ff_err}")),
        },
    }
}

impl H264SessionEncoder {
    pub(in crate::rc) fn set_capture_at(&mut self, at_ms: i64) { self.next_capture_at = at_ms; }

    fn stamp_packets(&mut self, result: Result<Vec<H264Packet>, String>) -> Result<Vec<H264Packet>, String> {
        match result {
            Ok(mut packets) => {
                // 两个后端都禁止 B 帧；输出顺序与提交输入一致。
                for p in &mut packets { p.at_ms = self.capture_times.pop_front().unwrap_or(self.next_capture_at); }
                if self.capture_times.len() > 120 { self.capture_times.clear(); }
                Ok(packets)
            }
            Err(e) => { self.capture_times.clear(); Err(e) }
        }
    }
    /// 按目标分辨率打开；基准码率由**宽度**决定（帧率因子与缩放在
    /// `scaled_bitrate` 统一乘）。
    pub fn try_open(codec: VideoCodec, width: u32, height: u32, fps: u32) -> Self {
        Self::try_open_with_scale(codec, width, height, fps, 100)
    }

    /// 结构体装配收口：三个出口（开成 / HEVC 回落 / 打不开）只差
    /// `enc` / `codec` / `hevc_broken`，其余字段同值——别抄三遍。
    fn shell(
        codec: VideoCodec,
        enc: Option<Backend>,
        base_bitrate: u32,
        fps: u32,
        scale_pct: u32,
        hevc_broken: bool,
    ) -> Self {
        Self {
            enc,
            codec,
            scale_pct,
            base_bitrate,
            fps,
            gpu_mode: false,
            reopen_needed: false,
            gpu_fail_streak: 0,
            hevc_fail_streak: 0,
            hevc_broken,
            nv12_buf: Vec::new(),
            scaler: Default::default(),
            cpu_perf: Default::default(),
            last_scale_change: None,
            pending_scale: None,
            budget_bps: None,
            pending_budget: None,
            resolution_limit: 0,
            capture_times: std::collections::VecDeque::new(),
            next_capture_at: 0,
        }
    }

    /// `scale_pct`：**打开时就生效**的码率缩放（%），与 `apply_bitrate_scale`
    /// 同域（10–300）。
    ///
    /// 🔴 2026-10-03 真机教训：过去恒按 100% 开（`try_open`），发起端的
    /// `SetBitratePct`（默认 200）在起播约 0.9s 后才到达 → 首帧刚出就又
    /// 全链重开一次。MFT/NVENC 两次初始化、重开周期内的帧全丢，起帧被
    /// 拖慢一整个重开。起播按当前倍率开，收到的值与现值相同就不再重开。
    ///
    /// 基准码率同样由**宽度**决定；30fps 标定，帧率因子只乘一次（在
    /// `scaled_bitrate` 里乘，见 tests::码率基准的帧率因子只乘一次）。
    ///
    /// 🔴 初始打开失败也要走回落链：HEVC MFT 缺失的机器按 H.264 再开一次。
    /// 帧内回落逻辑（[`Self::on_open_fail`]）只在 encode_* 路径可达，而调用方
    /// 对 `!available()` 直接 FallThrough 到 JPEG——不在这里兜，
    /// HEVC 档在这类机器上整场 JPEG 而不是 H.264（2026-09-19 审查 P2）。
    pub fn try_open_with_scale(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        scale_pct: u32,
    ) -> Self {
        let scale = scale_pct.clamp(10, 300);
        let base_bitrate = bitrate_for_width(width);
        // 初始打开的实际码率 = 基准 × 帧率因子 × 缩放，与 scaled_bitrate 同口径
        let initial = ((base_bitrate as u64 * fps_bitrate_factor(fps) * scale as u64) / 10_000) as u32;
        match open_chain(codec, width, height, fps, initial) {
            Ok(enc) => Self::shell(codec, Some(enc), base_bitrate, fps, scale, false),
            Err(e) => {
                if codec == VideoCodec::Hevc {
                    // HEVC 目标回落 H.264 时走同一条 open_chain：MF H264 也不行
                    // 还会试 FF（2026-09-19 P2 修复的延续，FF 是链上新增的下一级）。
                    if let Ok(enc) = open_chain(VideoCodec::H264, width, height, fps, initial) {
                        log::warn!("[RC] HEVC 初始打开失败，按回落链改用 H.264：{e}");
                        return Self::shell(
                            VideoCodec::H264,
                            Some(enc),
                            base_bitrate,
                            fps,
                            scale,
                            // 本会话已证实 HEVC 打不开：挡住后续 SetCodec(hevc) 反复重试
                            true,
                        );
                    }
                }
                log::warn!("[RC] {} 不可用，调用方回退：{e}", codec.as_str());
                Self::shell(codec, None, base_bitrate, fps, scale, false)
            }
        }
    }

    pub fn available(&self) -> bool {
        self.enc.is_some()
    }

    /// 指定码率打开（bit/s，下限 400k），HEVC 打不开自动回落 H.264。
    /// 原为远控「发送预算」专用（pub(in crate::rc)）；录屏（rec/）同样按
    /// 固定码率开本地编码会话——budget 路径下重开时码率恒定，语义正合适。
    pub fn try_open_with_budget(codec: VideoCodec, w: u32, h: u32, fps: u32, bps: u32) -> Self {
        let bps = bps.max(400_000);
        let enc = open_chain(codec, w, h, fps, bps);
        let mut result = match enc {
            Ok(enc) => Self::shell(codec, Some(enc), bitrate_for_width(w), fps, 100, false),
            Err(_) if codec == VideoCodec::Hevc => Self::shell(VideoCodec::H264,
                open_chain(VideoCodec::H264, w, h, fps, bps).ok(), bitrate_for_width(w), fps, 100, true),
            Err(e) => { log::warn!("[RC] 编码器起播失败：{e}");
                Self::shell(codec, None, bitrate_for_width(w), fps, 100, false) }
        };
        result.budget_bps = Some(bps);
        result
    }

    pub(in crate::rc) fn apply_bitrate_budget(&mut self, bps: u32) {
        let bps = bps.max(400_000);
        let old = self.scaled_bitrate();
        if old.abs_diff(bps) < (old / 10).max(50_000) { return; }
        let now = std::time::Instant::now();
        if self.enc.as_mut().is_some_and(|e| e.set_bitrate(bps)) {
            self.budget_bps = Some(bps);
            self.pending_budget = None;
            return;
        }
        // 不支持动态改码率的驱动，候选稳住且冷却结束才重开；容忍小幅探测变化。
        let since = match self.pending_budget {
            Some((candidate, t)) if candidate.abs_diff(bps) <= bps / 5 => t,
            _ => now,
        };
        self.pending_budget = Some((bps, since));
        // 容量骤降时连续变化的候选可能永远稳不住；大幅降码率必须允许
        // 提前重开，仍保留冷却以免每一轮拥塞反馈都重建编码器。
        if bps > old / 2 && now.duration_since(since) < SCALE_HOLD { return; }
        if self.last_scale_change.is_some_and(|t| now.duration_since(t) < SCALE_COOLDOWN) { return; }
        self.budget_bps = Some(bps);
        self.reopen_needed = true;
        self.pending_budget = None;
        self.last_scale_change = Some(now);
    }

    /// Q3：目标流标准（发送侧写进帧元数据）。
    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    /// Q3：会话中切换流标准（SetCodec）。变化标记重开，下次编码时生效；
    /// 打不开的处理见 encode_*（HEVC 失败自动回落 H.264）。
    pub fn set_codec(&mut self, codec: VideoCodec) {
        // 本会话已证实 HEVC 打不开（回落过）：不再反复切 HEVC 重试，
        // 否则「切 HEVC → 打不开 → 回 H.264」每两帧烧一个 JPEG 帧。
        if codec == VideoCodec::Hevc && self.hevc_broken {
            return;
        }
        if codec != self.codec {
            self.codec = codec;
            self.reopen_needed = true;
        }
    }

    /// 下一帧强制 IDR（见 `MfH264Encoder::force_key`）。编码器打不开时恒 false。
    pub fn force_key(&self) -> bool {
        self.enc.as_ref().is_some_and(|e| e.force_key())
    }
    pub fn scale_pct(&self) -> u32 {
        self.scale_pct
    }

    pub fn gpu_mode(&self) -> bool {
        self.gpu_mode
    }

    /// 时间戳 fps（调用方换画质档时同步更新）。
    pub fn set_fps(&mut self, fps: u32) {
        let fps = fps.max(1);
        if fps != self.fps {
            self.fps = fps;
            self.reopen_needed = true;
        }
    }

    /// RTT/丢包自适应：按百分比缩码率。变化 <15 个百分点不动（避免 thrashing）。
    /// 重开延迟到下一次编码（GPU 模式下重开需要 D3D 设备）。
    /// 无返回值——曾返回恒 false 的 bool，像「是否已生效」实则什么都没表达。
    ///
    /// 🔴 再审计 B5（2026-09-25）：差值迟滞之外再加**时间冷却**——RTT 在档位
    /// 边界抖动时（50%↔60%↔50%…）每次都跨过 15pp 判据，每次都是一次全链重开。
    /// 距上次生效 <2s 的变更被忽略；差值 ≥50pp 的剧变不受冷却约束
    /// （紧急降码率要能立即生效），两档阈值见 [`SCALE_COOLDOWN`] / [`SCALE_JUMP_PCT`]。
    pub fn apply_bitrate_scale(&mut self, scale_pct: u32) {
        // 🔴 再审计 A8（2026-09-25）：曾是 clamp(25, 100)，把 >100% 的值全部砍回
        // 100——用户在胶囊面板选 150%/200% 加码被静默丢弃（与当前值相等直接
        // return）。上游 `stream_cfg::bitrate_scale()` 的契约域是 10–300
        // （RTT/丢包 25–100 × 用户倍率 50–200），这里只做同域防御，不另立口径。
        let scale = scale_pct.clamp(10, 300);
        if scale == self.scale_pct {
            self.pending_scale = None;
            return;
        }
        if scale.abs_diff(self.scale_pct) < 15 && self.enc.is_some() {
            self.pending_scale = None;
            return;
        }
        let now = std::time::Instant::now();
        let diff = scale.abs_diff(self.scale_pct);
        // 2026-09-28 稳定窗口：同一新值从首见时刻起算；换成别的值就重置——
        // 在分段边界来回弹永远提交不了，稳住 SCALE_HOLD 才真正重开。
        let since = match self.pending_scale {
            Some((v, t)) if v == scale => t,
            _ => now,
        };
        self.pending_scale = Some((scale, since));
        if !scale_hold_satisfied(since, now, diff) {
            return;
        }
        // 🔴 B5：冷却期拦截也吃掉本次变更（与 <15pp 迟滞同款口径——变更被
        // 拒就整条拒，不排队），下一轮 RTT 上报会带着新值再来。
        if !scale_change_allowed(self.last_scale_change, now, diff) {
            return;
        }
        self.pending_scale = None;
        self.scale_pct = scale;
        self.reopen_needed = true;
        self.last_scale_change = Some(now);
    }

    pub(in crate::rc) fn scaled_bitrate(&self) -> u32 {
        if let Some(bps) = self.budget_bps { return bps; }
        // base（30fps 标定）× 帧率抬升 × RTT/丢包缩放；换档重开时生效
        ((self.base_bitrate as u64 * fps_bitrate_factor(self.fps) * self.scale_pct as u64) / 10_000)
            .max(400_000) as u32
    }

    /// 输入 BGRA（CPU 路径）。分辨率/模式/码率/编码标准变化会按需重开编码器。
    pub fn encode_bgra(&mut self, bgra: &[u8], w: u32, h: u32) -> Result<Vec<H264Packet>, String> {
        let started = std::time::Instant::now();
        let (ew, eh) = crate::rc::media_flow::scaled_dimensions(w, h, self.resolution_limit);
        let size_changed = self.enc.as_ref().map(|e| e.size()) != Some((ew, eh));
        if size_changed {
            self.base_bitrate = bitrate_for_width(ew);
        }
        if self.gpu_mode || self.reopen_needed || size_changed {
            self.capture_times.clear();
            // 🔴 再审计 B4(b)（2026-09-25）已知取舍：GPU 帧编码失败后同帧回落到
            // 这里时 `gpu_mode` 仍为 true ⇒ 必然全链重开成 CPU 编码器；下一帧
            // GPU 恢复又走 open_gpu——一次瞬时 GPU 故障要花两次全链重开（各几百
            // ms）。彻底消除需要同时持有 GPU/CPU 两个编码器实例（显存 + 内存
            // 双份、状态翻倍、重开时序复杂化），超出本轮审计的「小改」范畴，
            // 刻意不做。熔断把最坏情况兜住：encode_gpu 连续 3 次失败即返回
            // [gpu_disabled]，会话内不再尝试 GPU，重开随之收敛为一次。
            crate::rc::perf::bump(&crate::rc::perf::counters::ENC_REOPEN);
            // 本会话已经用 FF 正常出包时，重开先复用已验证的后端；不能每次
            // 换 fps/尺寸都花约 1 秒重试刚失败的 MF。FF 再失败仍走完整回落链。
            let opened = if matches!(self.enc.as_ref(), Some(Backend::Ff(_))) {
                FfEncoder::open(self.codec, ew, eh, self.fps, self.scaled_bitrate())
                    .map(Backend::Ff)
                    .or_else(|_| open_chain(self.codec, ew, eh, self.fps, self.scaled_bitrate()))
            } else { open_chain(self.codec, ew, eh, self.fps, self.scaled_bitrate()) };
            match opened {
                Ok(e) => {
                    self.enc = Some(e);
                    self.gpu_mode = false;
                    self.reopen_needed = false;
                    self.hevc_fail_streak = 0;
                }
                Err(e) => return Err(self.on_open_fail(e)),
            }
        }
        let open_time = started.elapsed();
        let prep_start = std::time::Instant::now();
        let mut scale_time = std::time::Duration::ZERO;
        // P2-8：NV12 输出缓冲挂在编码器上复用，4K 每帧省一次 12MB 分配。
        if (w, h) != (ew, eh) {
            let scaled = self.scaler.resize(bgra, w, h, ew, eh)?;
            scale_time = prep_start.elapsed();
            crate::rc::dxgi::bgra_to_nv12_into(scaled, ew, eh, &mut self.nv12_buf)?;
        } else {
            crate::rc::dxgi::bgra_to_nv12_into(bgra, ew, eh, &mut self.nv12_buf)?;
        }
        let convert_time = prep_start.elapsed().saturating_sub(scale_time);
        self.capture_times.push_back(self.next_capture_at);
        let enc = self.enc.as_mut().ok_or("无视频编码器")?;
        let encode_start = std::time::Instant::now();
        let encoded = enc.encode_nv12(&self.nv12_buf);
        self.cpu_perf.note((w, h), (ew, eh), [open_time, scale_time, convert_time, encode_start.elapsed()]);
        self.stamp_packets(encoded)
    }

    /// Q3：打开失败时的编码标准回退（**仅 CPU 链**，GPU 路径 streak 已拆分）。
    /// HEVC 连续 2 次打不开 → 本会话回落 H.264（返回的 Err 让本帧走 JPEG
    /// 兜底，下一帧起按 H.264 重开），并置 `hevc_broken` 挡住后续
    /// SetCodec(hevc) 反复重试。注意这里计的是**整链失败**——open_chain
    /// 已把 MF 和 FF 都试过，两个都败才走到这。
    fn on_open_fail(&mut self, e: String) -> String {
        if self.codec == VideoCodec::Av1 {
            // P2.3：AV1 打不开（无 nvenc/qsv/amf）立即回落 H.264，不重试——
            // 能力是静态的，反复重开只烧 CPU。
            log::warn!("[RC] AV1 硬编打不开，本会话回落 H.264：{e}");
            self.codec = VideoCodec::H264;
            self.reopen_needed = true;
            return e;
        }
        if self.codec == VideoCodec::Hevc {
            self.hevc_fail_streak += 1;
            if self.hevc_fail_streak >= 2 {
                log::warn!("[RC] HEVC 连续打不开，本会话回落 H.264：{e}");
                self.codec = VideoCodec::H264;
                self.hevc_fail_streak = 0;
                self.hevc_broken = true;
                self.reopen_needed = true;
            }
        }
        e
    }

    /// 🔴 再审计 B4（2026-09-25）：GPU **抓帧**（`DxgiPool::grab_gpu`）的失败也
    /// 计入同一条 `gpu_fail_streak`。过去只有「打开/编码」失败计数，抓帧失败
    /// 完全不记——GPU 管线在抓帧这层坏掉（AcquireNextFrame / staging 创建失败 /
    /// 输出拓扑对不上）时每帧白试一遍再回落 CPU，整个会话都不会判死。
    /// 阈值与熔断口径一致（≥3 次 → `[gpu_disabled]`，调用方置 `gpu_disabled`）。
    /// 返回值：未达阈值时原样透传错误；达阈值时改写为 `[gpu_disabled]` 前缀。
    pub(in crate::rc) fn note_gpu_grab_fail(&mut self, e: String) -> String {
        self.gpu_fail_streak += 1;
        if self.gpu_fail_streak >= 3 {
            log::warn!(
                "[RC] GPU 抓帧连续 {} 次失败，本会话回落 CPU 管线：{e}",
                self.gpu_fail_streak
            );
            "[gpu_disabled] GPU 零拷贝编码不可用".into()
        } else {
            e
        }
    }

    /// P1：输入 BGRA **GPU 纹理**（零拷贝路径，fps120 档）。
    /// 模式/码率/fps/尺寸变化 → 按 GPU 模式重开；连续 3 次打不开 →
    /// 报 `[gpu_disabled]`，本会话不再尝试（调用方回落 CPU 管线）。
    pub fn encode_gpu(
        &mut self,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        bgra: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> Result<Vec<H264Packet>, String> {
        let ew = w.max(64) & !1;
        let eh = h.max(64) & !1;
        let size_changed = self.enc.as_ref().map(|e| e.size()) != Some((ew, eh));
        if size_changed {
            self.base_bitrate = bitrate_for_width(ew);
        }
        if !self.gpu_mode || self.reopen_needed || size_changed {
            self.capture_times.clear();
            crate::rc::perf::bump(&crate::rc::perf::counters::ENC_REOPEN);
            match MfH264Encoder::open_gpu(self.codec, device, ctx, ew, eh, self.fps, self.scaled_bitrate())
            {
                Ok(e) => {
                    // GPU 零拷贝仅 MF 有（FF 只接 CPU 路径）；从 FF 切回 MF 是升级，
                    // 从 MF 切回 MF 是常规重开 —— 两种都合法。
                    self.enc = Some(Backend::Mf(e));
                    self.gpu_mode = true;
                    self.reopen_needed = false;
                    self.gpu_fail_streak = 0;
                    self.hevc_fail_streak = 0;
                }
                Err(e) => {
                    self.gpu_fail_streak += 1;
                    if self.gpu_fail_streak >= 3 {
                        log::warn!("[RC] 零拷贝路径连续 3 次打不开，本会话回落 CPU 管线：{e}");
                        return Err("[gpu_disabled] GPU 零拷贝编码不可用".into());
                    }
                    // 🔴 streak 按后端拆分（批 2）：GPU(MF) 的 HEVC 失败**只记
                    // gpu_fail_streak**，不再经 on_open_fail 判「HEVC 全局不可用」
                    // —— GPU 路径没有 FF，这里的失败说明不了 CPU 链（MF→FF HEVC）
                    // 也不行；熔断后调用方回落 CPU 管线，由那条链自己验证 HEVC。
                    return Err(e);
                }
            }
        }
        let enc = self.enc.as_mut().ok_or("无视频编码器")?;
        self.capture_times.push_back(self.next_capture_at);
        let encoded = enc.encode_texture(bgra, ew, eh);
        match self.stamp_packets(encoded) {
            Ok(p) => {
                // streak 度量「持续性故障」：单帧 hiccup 不累计
                self.gpu_fail_streak = 0;
                Ok(p)
            }
            Err(e) => {
                // 打开成功但逐帧编码失败（驱动异常/纹理不兼容）：曾只数「打开
                // 失败」，这类故障每帧都白跑一次 GPU 抓帧+转换再回退 CPU
                //（2026-09-19 审查 P3）。与打开失败共用同一熔断阈值。
                self.gpu_fail_streak += 1;
                if self.gpu_fail_streak >= 3 {
                    log::warn!("[RC] GPU 编码连续 3 帧失败，本会话回落 CPU 管线：{e}");
                    return Err("[gpu_disabled] GPU 零拷贝编码不可用".into());
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_backend_applies_large_drop_without_waiting_for_stability() {
        let mut enc = H264SessionEncoder::shell(VideoCodec::H264, None, 8_000_000, 30, 100, false);
        enc.apply_bitrate_budget(2_000_000);
        assert_eq!(enc.scaled_bitrate(), 2_000_000);
        assert!(enc.reopen_needed);
        enc.reopen_needed = false;
        enc.apply_bitrate_budget(1_000_000);
        assert_eq!(enc.scaled_bitrate(), 2_000_000, "紧急降档也不能连续重开");
        assert!(!enc.reopen_needed);
    }

    #[test]
    fn delayed_packet_uses_original_capture_time() {
        let mut enc = H264SessionEncoder::shell(VideoCodec::H264, None, 4_000_000, 30, 100, false);
        enc.capture_times.extend([100, 133, 166]);
        enc.next_capture_at = 166;
        let output = enc.stamp_packets(Ok(vec![H264Packet { at_ms: 0, data: vec![1], key: true, width: 64, height: 64 }])).unwrap();
        assert_eq!(output[0].at_ms, 100);
        assert_eq!(enc.capture_times.len(), 2);
        assert!(enc.stamp_packets(Err("broken".into())).is_err());
        assert!(enc.capture_times.is_empty());
    }

    /// 🔴 再审计 B5（2026-09-25）守卫单测：码率缩放变更的时间冷却。
    /// 钉住三档行为——冷却期内的小幅变更拦截、剧变（≥50pp）豁免、冷却期满放行。
    #[test]
    fn 码率缩放变更的时间冷却() {
        let now = std::time::Instant::now();
        // 从未变更过：恒放行
        assert!(scale_change_allowed(None, now, 5));
        // 冷却期内的小幅变更（15~49pp）：拦截
        let just_changed = now - std::time::Duration::from_millis(500);
        assert!(!scale_change_allowed(Some(just_changed), now, 20));
        // 冷却期内的剧变（≥50pp）：豁免，紧急降码率立即生效
        assert!(scale_change_allowed(Some(just_changed), now, 50));
        assert!(scale_change_allowed(Some(just_changed), now, 200));
        // 冷却期满（≥2s）：放行
        let cooled = now - std::time::Duration::from_secs(2);
        assert!(scale_change_allowed(Some(cooled), now, 20));
    }

    /// 🔴 2026-09-28 守卫单测：码率缩放的稳定窗口。钉住——候选值稳够 3s 才
    /// 放行、剧变豁免、窗口未满拦截。防回归：帧龄分段边界弹跳不再逐次重开。
    #[test]
    fn 码率缩放的稳定窗口() {
        let now = std::time::Instant::now();
        // 刚出现的候选（<3s）：非剧变拦截
        let fresh = now - std::time::Duration::from_millis(500);
        assert!(!scale_hold_satisfied(fresh, now, 30));
        // 稳够 3s：放行
        let held = now - std::time::Duration::from_secs(3);
        assert!(scale_hold_satisfied(held, now, 30));
        // 剧变（≥50pp）：恒豁免（紧急降码率不等窗口）
        assert!(scale_hold_satisfied(fresh, now, 50));
        assert!(scale_hold_satisfied(fresh, now, 200));
    }
}
