//! 会话级编码器封装（H264SessionEncoder：档位/码率协商）。

use super::*;

/// 会话包装：open 失败则标记不可用，调用方走 JPEG。
///
/// P1：CPU（内存 NV12）与 GPU（D3D11 零拷贝）双模。码率变化不再立刻重开，
/// 统一记为「待重开」，下一次编码时（CPU/GPU 各自带上下文）执行——
/// GPU 重开需要 D3D 设备，只有 encode_gpu 时刻才有。
pub struct H264SessionEncoder {
    pub(in crate::rc) enc: Option<MfH264Encoder>,
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
}

// windows-rs COM 指针非 Send；本进程 MTA + 会话任务串行访问。
unsafe impl Send for H264SessionEncoder {}
unsafe impl Send for MfH264Encoder {}

impl H264SessionEncoder {
    /// 按目标分辨率打开；基准码率由**宽度**决定（帧率因子在 scaled_bitrate 统一乘）。
    pub fn try_open(codec: VideoCodec, width: u32, height: u32, fps: u32) -> Self {
        Self::try_open_with_bitrate(codec, width, height, fps, bitrate_for_width(width))
    }

    /// `base_bitrate` 是 30fps 标定的宽度基准（见 [`Self::base_bitrate`] 字段注释）。
    ///
    /// 🔴 初始打开失败也要走回落链：HEVC MFT 缺失的机器按 H.264 再开一次。
    /// 帧内回落逻辑（[`Self::on_open_fail`]）只在 encode_* 路径可达，而调用方
    /// 对 `!available()` 直接 FallThrough 到 JPEG——不在这里兜，
    /// HEVC 档在这类机器上整场 JPEG 而不是 H.264（2026-09-19 审查 P2）。
    pub fn try_open_with_bitrate(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        base_bitrate: u32,
    ) -> Self {
        // 初始打开的实际码率 = 基准 × 帧率因子（缩放 100%），与 scaled_bitrate 同口径
        let initial = ((base_bitrate as u64 * fps_bitrate_factor(fps)) / 100) as u32;
        let unavailable = |std: VideoCodec, e: String| {
            log::warn!("[RC] {} 不可用，调用方回退：{e}", std.as_str());
            Self {
                enc: None,
                codec,
                scale_pct: 100,
                base_bitrate,
                fps,
                gpu_mode: false,
                reopen_needed: false,
                gpu_fail_streak: 0,
                hevc_fail_streak: 0,
                hevc_broken: false,
                nv12_buf: Vec::new(),
            }
        };
        match MfH264Encoder::open(codec, width, height, fps, initial) {
            Ok(e) => Self {
                enc: Some(e),
                codec,
                scale_pct: 100,
                base_bitrate,
                fps,
                gpu_mode: false,
                reopen_needed: false,
                gpu_fail_streak: 0,
                hevc_fail_streak: 0,
                hevc_broken: false,
                nv12_buf: Vec::new(),
            },
            Err(e) => {
                if codec == VideoCodec::Hevc {
                    if let Ok(h264_enc) =
                        MfH264Encoder::open(VideoCodec::H264, width, height, fps, initial)
                    {
                        log::warn!("[RC] HEVC 初始打开失败，按回落链改用 H.264：{e}");
                        return Self {
                            enc: Some(h264_enc),
                            codec: VideoCodec::H264,
                            scale_pct: 100,
                            base_bitrate,
                            fps,
                            gpu_mode: false,
                            reopen_needed: false,
                            gpu_fail_streak: 0,
                            hevc_fail_streak: 0,
                            // 本会话已证实 HEVC 打不开：挡住后续 SetCodec(hevc) 反复重试
                            hevc_broken: true,
                            nv12_buf: Vec::new(),
                        };
                    }
                }
                unavailable(codec, e)
            }
        }
    }

    pub fn available(&self) -> bool {
        self.enc.is_some()
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

    /// RTT/丢包自适应：按百分比缩码率。变化 <15% 不动（避免 thrashing）。
    /// 重开延迟到下一次编码（GPU 模式下重开需要 D3D 设备）。
    /// 无返回值——曾返回恒 false 的 bool，像「是否已生效」实则什么都没表达。
    pub fn apply_bitrate_scale(&mut self, scale_pct: u32) {
        let scale = scale_pct.clamp(25, 100);
        if scale == self.scale_pct {
            return;
        }
        if scale.abs_diff(self.scale_pct) < 15 && self.enc.is_some() {
            return;
        }
        self.scale_pct = scale;
        self.reopen_needed = true;
    }

    pub(in crate::rc) fn scaled_bitrate(&self) -> u32 {
        // base（30fps 标定）× 帧率抬升 × RTT/丢包缩放；换档重开时生效
        ((self.base_bitrate as u64 * fps_bitrate_factor(self.fps) * self.scale_pct as u64) / 10_000)
            .max(400_000) as u32
    }

    /// 输入 BGRA（CPU 路径）。分辨率/模式/码率/编码标准变化会按需重开编码器。
    pub fn encode_bgra(&mut self, bgra: &[u8], w: u32, h: u32) -> Result<Vec<H264Packet>, String> {
        let ew = w.max(64) & !1;
        let eh = h.max(64) & !1;
        let size_changed = self.enc.as_ref().map(|e| e.size()) != Some((ew, eh));
        if size_changed {
            self.base_bitrate = bitrate_for_width(ew);
        }
        if self.gpu_mode || self.reopen_needed || size_changed {
            match MfH264Encoder::open(self.codec, ew, eh, self.fps, self.scaled_bitrate()) {
                Ok(e) => {
                    self.enc = Some(e);
                    self.gpu_mode = false;
                    self.reopen_needed = false;
                    self.hevc_fail_streak = 0;
                }
                Err(e) => return Err(self.on_open_fail(e)),
            }
        }
        let enc = self.enc.as_mut().ok_or("无视频编码器")?;
        // P2-8：NV12 输出缓冲挂在编码器上复用，4K 每帧省一次 12MB 分配。
        crate::rc::dxgi::bgra_to_nv12_into(bgra, ew, eh, &mut self.nv12_buf)?;
        enc.encode_nv12(&self.nv12_buf)
    }

    /// Q3：打开失败时的编码标准回退。HEVC 连续 2 次打不开 → 本会话回落
    /// H.264（返回的 Err 让本帧走 JPEG 兜底，下一帧起按 H.264 重开），
    /// 并置 `hevc_broken` 挡住后续 SetCodec(hevc) 反复重试。
    fn on_open_fail(&mut self, e: String) -> String {
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
            match MfH264Encoder::open_gpu(self.codec, device, ctx, ew, eh, self.fps, self.scaled_bitrate())
            {
                Ok(e) => {
                    self.enc = Some(e);
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
                    // GPU 没坏也可能只是这路 HEVC 不行：on_open_fail 记 HEVC 连败
                    // 并在 ≥2 次后把目标标准切回 H.264（下一帧按 H.264 重开）。
                    return Err(self.on_open_fail(e));
                }
            }
        }
        let enc = self.enc.as_mut().ok_or("无视频编码器")?;
        match enc.encode_texture(bgra, ew, eh) {
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
