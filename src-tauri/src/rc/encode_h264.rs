//! R4.1 — Media Foundation 硬件 H.264 编码器。
//!
//! 优先硬件 MFT；不可用则整段会话回退 JPEG。输入 NV12，输出 Annex-B。
//!
//! R5.B：profile 用 **High(100)**，level 随分辨率抬升（最高 5.1 覆盖 4K@30），
//! 码率按宽查表。打开尺寸跟抓屏走，不再写死 1280×720。

#![cfg(target_os = "windows")]

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};

/// H.264 High profile（MF_MT_MPEG2_PROFILE）。
pub const H264_PROFILE_HIGH: u32 = 100;

/// Q3：视频编码标准。决定 MFT 枚举的输出 subtype、profile/level 标注
/// 与前端 WebCodecs 解码串；码控/低延迟/强制关键帧的 ICodecAPI 键两家通用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
}

impl VideoCodec {
    /// MFT 枚举与输出媒体类型的 subtype。
    pub fn mf_subtype(&self) -> &'static windows::core::GUID {
        match self {
            Self::H264 => &MFVideoFormat_H264,
            Self::Hevc => &MFVideoFormat_HEVC,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
        }
    }

    pub fn of_str(s: &str) -> Option<Self> {
        match s {
            "h264" => Some(Self::H264),
            "hevc" => Some(Self::Hevc),
            _ => None,
        }
    }
}

/// 按编码宽高选 H.264 level（MF_MT_MPEG2_LEVEL）。
/// 5.1 覆盖 4K@30；更小画面用更低 level，兼容性更好。
///
/// 审查 D4（2026-09-19）：level 的宏块率上限不含帧率维度会写出**超规格流**——
/// 1080p120（≈979200 MB/s）超出 L4.2（522240）约 87%，部分硬编 MFT 会拒开、
/// 部分解码器按超规格处理。fps > 60 一律抬到 5.1（983040 MB/s，覆盖 1080p120）。
///
/// Q4（2026-09-19）：4K60（uhd60 档 H.264 兜底路径）= 32400 MB/帧 × 60 ≈
/// 194 万 MB/s，连 L5.1 都超规格约一倍，必须抬到 L5.2。改为按宏块率精确
/// 取档（下限保持旧启发式，只升不降，避免 1080p30 退化到 L4.0 的兼容风险）。
pub fn h264_level_for(width: u32, height: u32, fps: u32) -> u32 {
    let (w, h) = (width.max(1), height.max(1));
    let mut level = if w >= 3200 || h >= 1800 {
        51 // 4K
    } else if w >= 2560 || h >= 1440 {
        50
    } else if w >= 1920 || h >= 1080 {
        42
    } else {
        40
    };
    if fps > 60 && level < 51 {
        level = 51;
    }
    // 宏块率校验：ceil(w/16) × ceil(h/16) × fps 必须落在 level 的 MaxMBPS 内。
    // 只升不降：低端按旧启发式（兼容性优先），超了才抬。
    let frame_mbs = (w.div_ceil(16) as u64) * (h.div_ceil(16) as u64) * fps.max(1) as u64;
    // [L4.0=40, L4.2=42, L5.0=50, L5.1=51, L5.2=52] 的 MaxMBPS（规范表）
    for (lv, max_mbs) in [(40u32, 245_760u64), (42, 522_240), (50, 589_824), (51, 983_040), (52, 2_073_600)] {
        if frame_mbs <= max_mbs {
            if lv > level {
                level = lv;
            }
            break;
        }
    }
    level
}

/// WebCodecs `codec` 字符串（前端同口径）：High + level hex。
/// 例：2160p → `avc1.640033`（High@5.1）；1080p120 同样 5.1。
pub fn webcodecs_codec_str(width: u32, height: u32, fps: u32) -> String {
    let level = h264_level_for(width, height, fps);
    format!("avc1.64{:04x}", level)
}

/// Q3：HEVC 的 WebCodecs 解码串。Main profile（general_profile_idc=1）、
/// Main tier、level 按 30×level 取档：L4.0=120、L4.1=123、L5.0=150、L5.1=153、L5.2=156。
///
/// 🔴 level 按 **luma 采样率**（w×h×fps，HEVC Main tier MaxLumaSr）取最小覆盖档，
/// 与 H.264 的 [`h264_level_for`] 同一套思路。曾只按分辨率二分（≥1800p → L5.1，
/// 否则 L4.0）：L4.0 的 MaxLumaSr 只有 66.7M——1080p60（124M）、1440p30/60
/// 全部超规格 1.9~3.3 倍，严格解码端 / `isConfigSupported` 会拒。
/// 不带 description 的 `hev1` 串 = Annex-B 流，与 H.264 路径同一约定。
pub fn webcodecs_hevc_str(width: u32, height: u32, fps: u32) -> String {
    let (w, h) = (width.max(1), height.max(1));
    // fps=0 = 未指定（探底配置）：实际流至少 30fps，按 60 兜最坏情况——
    // 宁可把 level 报高一档，也不能把解码端配置在流规格之下。
    let f = if fps == 0 { 60 } else { fps.max(1) };
    let luma_sr = w as u64 * h as u64 * f as u64;
    let level_idc = if luma_sr > 534_768_640 {
        156 // L5.2
    } else if luma_sr > 267_382_784 {
        153 // L5.1
    } else if luma_sr > 133_691_392 {
        150 // L5.0
    } else if luma_sr > 66_732_480 {
        123 // L4.1
    } else {
        120 // L4.0
    };
    format!("hev1.1.6.L{level_idc}.B0")
}

/// 按编码宽度选目标码率（bit/s）基准。4K 局域网给足带宽，避免糊成马赛克。
/// 表按 30fps 标定；实际码率 = 基准 × [`fps_bitrate_factor`]。
pub fn bitrate_for_width(width: u32) -> u32 {
    match width {
        w if w >= 3200 => 22_000_000,
        w if w >= 2560 => 14_000_000,
        w if w >= 1920 => 8_000_000,
        w if w >= 1600 => 5_000_000,
        w if w >= 1200 => 3_000_000,
        _ => 1_500_000,
    }
}

/// 审查 D3（2026-09-19）：码率基准按 30fps 标定，帧率翻倍不抬码率 = 每帧
/// 码率腰斩——fps120 档 1080p 只剩 66Kbit/帧，画面明显发糊。业界同档
/// （Moonlight 1080p60/120）给 15~40Mbps，这里 60fps ×1.6、120fps ×2.6
/// （1080p ≈ 21Mbps），跨网时仍由 RTT/丢包的 scale_pct 往下压。
pub fn fps_bitrate_factor(fps: u32) -> u64 {
    match fps {
        0..=30 => 100,
        31..=60 => 160,
        _ => 260,
    }
}

/// 宽度 + 帧率 → 目标码率（bit/s）。
pub fn bitrate_for(width: u32, fps: u32) -> u32 {
    ((bitrate_for_width(width) as u64 * fps_bitrate_factor(fps)) / 100) as u32
}

pub struct H264Packet {
    pub data: Vec<u8>,
    pub key: bool,
    pub width: u32,
    pub height: u32,
}

pub struct MfH264Encoder {
    transform: IMFTransform,
    /// Q3：本编码器出的是什么流（H.264/HEVC）。发送侧写进帧元数据，
    /// 前端据此选解码器。
    codec: VideoCodec,
    /// P1：硬件 MFT 绝大多数是 **async MFT**——必须走事件协议（拿到
    /// METransformNeedInput 才能喂帧、METransformHaveOutput 才能收包）。
    /// 之前的同步 ProcessInput 在 async MFT 上每帧都失败，整条硬编路径
    /// 静默退化成 JPEG。None = 同步 MFT（收件箱软编），直接 ProcessInput。
    events: Option<IMFMediaEventGenerator>,
    need_input: bool,
    have_output: bool,
    /// 异步首帧放长等待（编码器初始化常有几百 ms）。
    async_first_wait: bool,
    /// ICodecAPI（厂商 MFT 可能不暴露 → None）：低延迟/码控/GOP/强制关键帧都走它。
    codec_api: Option<ICodecAPI>,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    frame_idx: u64,
    com_owned: bool,
    pending: Vec<H264Packet>,
    /// P1：D3D11 零拷贝模式（fps120 档）。Some = BGRA 纹理经 VideoProcessor
    /// 转成 NV12 纹理直接进编码器，全程不碰显存读回。
    gpu: Option<super::gpu::GpuNv12Converter>,
}

/// MFStartup 进程级一次（视频/音频编码器共用；线程安全）。
pub fn ensure_mf_startup() -> Result<(), String> {
    static INIT: std::sync::Once = std::sync::Once::new();
    static INIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    INIT.call_once(|| unsafe {
        let r = MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL);
        if let Err(e) = &r {
            log::warn!("[RC] MFStartup 失败：{e}");
        }
        INIT_OK.store(r.is_ok(), std::sync::atomic::Ordering::SeqCst);
    });
    if INIT_OK.load(std::sync::atomic::Ordering::SeqCst) {
        Ok(())
    } else {
        Err("MFStartup 失败".into())
    }
}

fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

/// 逐项尽力设置 ICodecAPI（VT_UI4）。厂商 MFT 支持度参差——
/// 单项失败只记 warn，绝不因此中断会话（默认行为兜底）。
unsafe fn codecapi_set_u32(api: &ICodecAPI, key: &windows::core::GUID, value: u32, what: &str) {
    let v = windows::core::VARIANT::from(value);
    if let Err(e) = api.SetValue(key, &v) {
        log::warn!("[RC] CODECAPI {what}={value} 不被支持：{e}");
    }
}

impl MfH264Encoder {
    pub fn open(codec: VideoCodec, width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        Self::open_inner(codec, width, height, fps, bitrate, None)
    }

    /// P1：D3D11 零拷贝模式。编码器绑定 D3D 设备（MF_SA_D3D11_AWARE 的
    /// 硬件 MFT），输入用 GPU 纹理包装的 sample。
    pub fn open_gpu(
        codec: VideoCodec,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        Self::open_inner(codec, width, height, fps, bitrate, Some((device, ctx)))
    }

    fn open_inner(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        gpu: Option<(&ID3D11Device, &ID3D11DeviceContext)>,
    ) -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            ensure_mf_startup()?;

            let w = (width & !1).max(64);
            let h = (height & !1).max(64);

            // 审查 M1（混合显卡）：零拷贝路径的纹理来自 DXGI 池的适配器，
            // 编码 MFT 必须在同一适配器上——跨 GPU 传纹理要么直接失败、
            // 要么暗中多一份拷贝。GPU 模式带 LUID 优先匹配；CPU 模式喂的是
            // 内存缓冲，无需匹配。
            let prefer_adapter = gpu.and_then(|(dev, _)| adapter_luid_of(dev));
            let transform = create_h264_mft(prefer_adapter, codec)?;

            // 🔴 硬件 MFT 是 async：必须先解锁（MF_TRANSFORM_ASYNC_UNLOCK）再设类型，
            // 否则 SetInputType/ProcessInput 直接失败——之前同步用法在 async MFT 上
            // 表现为「硬编永远打不开、每帧静默回 JPEG」。
            let attrs = transform.GetAttributes().map_err(mf_err)?;
            let is_async = attrs
                .GetUINT32(&MF_TRANSFORM_ASYNC)
                .map(|v| v != 0)
                .unwrap_or(false);
            let events: Option<IMFMediaEventGenerator> = if is_async {
                attrs
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(mf_err)?;
                let eg: IMFMediaEventGenerator = transform
                    .cast()
                    .map_err(|e| format!("MFT 事件源：{e}"))?;
                Some(eg)
            } else {
                None
            };

            // P1：D3D 管理器必须**在设类型之前**绑（MFT 以 D3D11 模式协商分配器）
            if let Some((dev, _ctx)) = gpu {
                let mut token = 0u32;
                let mut mgr: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut token, &mut mgr).map_err(mf_err)?;
                let mgr = mgr.ok_or("DXGIDeviceManager 创建为空")?;
                mgr.ResetDevice(dev, token).map_err(mf_err)?;
                let unk: windows::core::IUnknown = mgr.cast().map_err(|e| format!("cast：{e}"))?;
                transform
                    .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, unk.as_raw() as usize)
                    .map_err(mf_err)?;
            }

            let in_type = create_video_type(&MFVideoFormat_NV12, w, h)?;
            transform.SetInputType(0, &in_type, 0).map_err(mf_err)?;

            let out_type = create_video_type(codec.mf_subtype(), w, h)?;
            out_type
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(mf_err)?;
            out_type
                .SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1))
                .map_err(mf_err)?;
            out_type
                .SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
                .map_err(mf_err)?;
            // Q3：profile/level 标注只有 H.264 设——HEVC MFT 按默认 Main 出流，
            // 强写 H.264 语义的 MF_MT_MPEG2_PROFILE/LEVEL 在部分 HEVC MFT 上会拒开。
            if codec == VideoCodec::H264 {
                out_type
                    .SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH)
                    .map_err(mf_err)?;
                out_type
                    .SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h, fps))
                    .map_err(mf_err)?;
            }
            transform.SetOutputType(0, &out_type, 0).map_err(mf_err)?;

            // P1：VideoProcessor 转换器（BGRA → NV12，显存内）
            let gpu_conv = match gpu {
                Some((dev, ctx)) => Some(super::gpu::GpuNv12Converter::new(dev, ctx, w, h)?),
                None => None,
            };
            // 🔴 低延迟三件套（2026-09-19）：MFT 默认带流水线缓冲（实测吃掉数帧、
            // 20~60ms），远程画面必须逐帧进出。
            // ① MF_LOW_LATENCY（IMFAttributes，Win8+）；② AVLowLatencyMode（ICodecAPI）；
            // ③ 显式码控 CBR + GOP，替换「只设 MF_MT_AVG_BITRATE」的默认行为。
            // 任何一项不被支持都只 warn——编码器按默认行为继续工作。
            if let Ok(attrs) = transform.cast::<IMFAttributes>() {
                if let Err(e) = attrs.SetUINT32(&MF_LOW_LATENCY, 1) {
                    log::warn!("[RC] MF_LOW_LATENCY 不被支持：{e}");
                }
            }
            let codec_api: Option<ICodecAPI> = transform.cast::<ICodecAPI>().ok();
            if let Some(api) = &codec_api {
                codecapi_set_u32(api, &CODECAPI_AVLowLatencyMode, 1, "AVLowLatencyMode");
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncCommonRateControlMode,
                    eAVEncCommonRateControlMode_CBR.0 as u32,
                    "RateControlMode=CBR",
                );
                codecapi_set_u32(api, &CODECAPI_AVEncCommonMeanBitRate, bitrate, "MeanBitRate");
                // P0-3：GOP = fps×1（1s）。之前是 ×2（2s）：解码断链又没等到
                // ForceKeyFrame 时要花 2s 等自然 GOP。request_key 自愈兜底 + 1s GOP。
                codecapi_set_u32(api, &CODECAPI_AVEncMPVGOPSize, fps.max(1), "GoPSize=1s");
                // P2-2：滚动帧内刷新（Gradual Intra Refresh）——用「每帧刷一列宏块」
                // 代替整帧 IDR：码率不突刺、丢包局部愈合。厂商 MFT 支持度参差
                //（NVENC/新 Intel 支持），不支持只 warn，编码器按默认行为继续。
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncVideoGradualIntraRefresh,
                    fps.max(1),
                    "GradualIntraRefresh(1s周期)",
                );
                // Q1：标注 limited range（尽力而为）。色彩矩阵没有 ICodecAPI 键——
                // 编码侧已统一 BT.709（dxgi/gpu），未标注 VUI 的 HD 流浏览器按
                // 709 解读，两侧口径一致。
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncVideoOutputColorNominalRange,
                    eAVEncVideoColorNominalRange_16_235.0 as u32,
                    "OutputColorNominalRange=16_235",
                );
            }

            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(mf_err)?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(mf_err)?;

            Ok(Self {
                transform,
                codec,
                events,
                need_input: false,
                have_output: false,
                async_first_wait: true,
                codec_api,
                width: w,
                height: h,
                fps: fps.max(1),
                bitrate,
                frame_idx: 0,
                com_owned,
                pending: Vec::new(),
                gpu: gpu_conv,
            })
        }
    }

    /// 本编码器的流标准（Q3，发送侧写进帧元数据）。
    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    /// 请求下一帧强制为 IDR（弱网花屏自愈：前端解码断链时要点一次）。
    /// 返回是否设置成功（不支持的 MFT 返回 false，调用方等自然 GOP）。
    pub fn force_key(&self) -> bool {
        let Some(api) = &self.codec_api else {
            return false;
        };
        let v = windows::core::VARIANT::from(1u32);
        unsafe { api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &v).is_ok() }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Vec<H264Packet>, String> {
        unsafe {
            let need = (self.width * self.height * 3 / 2) as usize;
            if nv12.len() < need {
                return Err(format!("NV12 不足 {} < {}", nv12.len(), need));
            }
            let sample = make_sample(nv12, need, self.frame_idx, self.fps)?;
            self.frame_idx += 1;
            self.submit_and_collect(sample)?;
            Ok(std::mem::take(&mut self.pending))
        }
    }

    /// P1 零拷贝编码：BGRA 捕获纹理 → VideoProcessor → NV12 纹理 → 编码器。
    pub fn encode_texture(
        &mut self,
        bgra: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> Result<Vec<H264Packet>, String> {
        let conv = self
            .gpu
            .as_mut()
            .ok_or("编码器不是 D3D11 零拷贝模式")?;
        let (ew, eh) = ((w.max(64) & !1), (h.max(64) & !1));
        if conv.size() != (ew, eh) {
            return Err(format!("纹理尺寸不符：{ew}x{eh} vs 编码器 {}x{}", conv.size().0, conv.size().1));
        }
        let nv12 = conv.convert(bgra)?;
        let sample = unsafe { make_dxgi_sample(&nv12, self.frame_idx, self.fps)? };
        self.frame_idx += 1;
        self.submit_and_collect(sample)?;
        Ok(std::mem::take(&mut self.pending))
    }

    /// 喂一帧 + 收产出。同步 MFT 直接 ProcessInput / 循环 ProcessOutput；
    /// 异步 MFT 走事件协议：等 NeedInput → 喂 → 等 HaveOutput → 收。
    /// 任何等待都有上界（首帧 2s、之后 300ms）——超时报错让调用方回退 JPEG，
    /// 绝不卡死推流循环。
    fn submit_and_collect(&mut self, sample: IMFSample) -> Result<(), String> {
        unsafe {
            match self.events.clone() {
                None => {
                    self.transform.ProcessInput(0, &sample, 0).map_err(mf_err)?;
                    self.drain()?;
                }
                Some(events) => {
                    let wait_ms = if self.async_first_wait { 2000 } else { 300 };
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
                    while !self.need_input {
                        self.pump_one(&events, Some(deadline))?;
                    }
                    self.need_input = false;
                    self.transform.ProcessInput(0, &sample, 0).map_err(mf_err)?;
                    // 低延迟模式一进一出；队列里残留的旧 HaveOutput 也一并收掉，
                    // 否则输出逐帧漂移、延迟累积。
                    let mut collected = 0usize;
                    loop {
                        let pumped = self.pump_one(&events, Some(deadline))?;
                        if self.have_output {
                            self.have_output = false;
                            self.drain_once()?;
                            collected += 1;
                        }
                        if collected >= 4 || (collected > 0 && !pumped) {
                            break;
                        }
                    }
                    if collected == 0 {
                        return Err("编码器一帧未出（低延迟模式异常）".into());
                    }
                    self.async_first_wait = false;
                }
            }
            Ok(())
        }
    }

    /// 非阻塞泵一个事件。`deadline=None` 时不等待、只探一次；
    /// 返回是否真的处理了事件（调用方据此判断队列是否已空）。
    fn pump_one(
        &mut self,
        events: &IMFMediaEventGenerator,
        deadline: Option<std::time::Instant>,
    ) -> Result<bool, String> {
        unsafe {
            match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(ev) => self.on_event(ev).map(|_| true),
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => match deadline {
                    None => Ok(false),
                    Some(d) if std::time::Instant::now() >= d => {
                        Err("等待编码器事件超时（MFT 无响应）".into())
                    }
                    Some(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        Ok(false)
                    }
                },
                Err(e) => Err(format!("MF 事件泵：{e}")),
            }
        }
    }

    fn on_event(&mut self, ev: IMFMediaEvent) -> Result<(), String> {
        let t = unsafe { ev.GetType() }.unwrap_or(0);
        if t == MEError.0 as u32 {
            return Err("编码器错误事件（MEError）".into());
        }
        if t == METransformNeedInput.0 as u32 {
            self.need_input = true;
        }
        if t == METransformHaveOutput.0 as u32 {
            self.have_output = true;
        }
        Ok(())
    }

    unsafe fn drain(&mut self) -> Result<(), String> {
        loop {
            match self.drain_once_raw() {
                Ok(true) => continue, // 还有产出，继续收
                Ok(false) => break,   // NEED_MORE_INPUT：编码器没货了
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// 收一次输出（异步模式：HaveOutput 到了调一次）。返回是否有产出。
    unsafe fn drain_once(&mut self) -> Result<(), String> {
        self.drain_once_raw().map(|_| ())
    }

    unsafe fn drain_once_raw(&mut self) -> Result<bool, String> {
        let od = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            ..Default::default()
        };
        let mut status = 0u32;
        let mut outs = [od];
        match self.transform.ProcessOutput(0, &mut outs, &mut status) {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(false),
            Err(e) => return Err(format!("ProcessOutput：{e}")),
        }
        if let Some(sample) = outs[0].pSample.as_ref() {
            if let Ok(buf) = sample.ConvertToContiguousBuffer() {
                if let Ok(bytes) = lock_buf(&buf) {
                    let key = match sample.GetUINT32(&MFSampleExtension_CleanPoint) {
                        Ok(v) => v != 0,
                        Err(_) => self.pending.is_empty(),
                    };
                    self.pending.push(H264Packet {
                        data: to_annex_b(&bytes),
                        key,
                        width: self.width,
                        height: self.height,
                    });
                }
            }
        }
        Ok(true)
    }
}

impl Drop for MfH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        if self.com_owned {
            unsafe { CoUninitialize() };
        }
    }
}

/// 提取 D3D11 设备所在 DXGI 适配器的 LUID（打包成 u64：High<<32 | Low）。
/// 提不到（异常驱动）返回 None，调用方退回「枚举第一个」的旧行为。
fn adapter_luid_of(device: &ID3D11Device) -> Option<u64> {
    use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGIAdapter};
    unsafe {
        let dxgi: IDXGIDevice = device.cast().ok()?;
        let adapter: IDXGIAdapter = dxgi.GetAdapter().ok()?;
        let desc = adapter.GetDesc().ok()?;
        Some(((desc.AdapterLuid.HighPart as i64 as u64) << 32) | desc.AdapterLuid.LowPart as u64)
    }
}

unsafe fn create_h264_mft(prefer_adapter: Option<u64>, codec: VideoCodec) -> Result<IMFTransform, String> {
    let in_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *codec.mf_subtype(),
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    // 硬件 MFT 多为 async：不能只用 HARDWARE|SYNCMFT（会枚举 0 个掉进软编）
    for flags in [
        MFT_ENUM_FLAG_HARDWARE,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT,
        MFT_ENUM_FLAG_ALL,
    ] {
        count = 0;
        acts = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            Some(&in_info),
            Some(&out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            break;
        }
    }
    if count == 0 || acts.is_null() {
        return Err(format!("无 {} MFT", codec.as_str()));
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    // 审查 M1：混合显卡上按适配器 LUID 挑 MFT（MFT_ENUM_ADAPTER_LUID，
    // VT_UI8 = High<<32|Low）。属性读不到/没有匹配项 → 退回第一个（旧行为）。
    let mut chosen: Option<IMFActivate> = None;
    if let Some(want) = prefer_adapter {
        for a in slice.iter().flatten() {
            if let Ok(attrs) = a.GetUINT64(&MFT_ENUM_ADAPTER_LUID) {
                if attrs == want {
                    chosen = Some(a.clone());
                    break;
                }
            }
        }
        if chosen.is_none() {
            log::warn!("[RC] 没有 LUID 匹配的编码 MFT，退回枚举第一个（跨适配器可能失败）");
        }
    }
    let first = chosen.or_else(|| slice[0].clone()).ok_or("MFT activate 为空")?;
    CoTaskMemFree(Some(acts as _));
    first
        .ActivateObject::<IMFTransform>()
        .map_err(|e| format!("ActivateObject：{e}"))
}

unsafe fn create_video_type(
    subtype: &windows::core::GUID,
    w: u32,
    h: u32,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(mf_err)?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(mf_err)?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(mf_err)?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32x2(1, 1))
        .map_err(mf_err)?;
    Ok(t)
}

fn pack_u32x2(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

fn pack_ratio(n: u32, d: u32) -> u64 {
    pack_u32x2(n, d)
}

/// P1：把 NV12 GPU 纹理包装成编码器输入 sample（D3D11-aware MFT 用）。
unsafe fn make_dxgi_sample(
    tex: &ID3D11Texture2D,
    idx: u64,
    fps: u32,
) -> Result<IMFSample, String> {
    let iid = <ID3D11Texture2D as Interface>::IID;
    let buf = MFCreateDXGISurfaceBuffer(&iid, tex, 0, false).map_err(mf_err)?;
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

unsafe fn make_sample(nv12: &[u8], len: usize, idx: u64, fps: u32) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(len as u32).map_err(mf_err)?;
    {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut max = 0u32;
        let mut cur = 0u32;
        buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
            .map_err(mf_err)?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, len);
        }
        buf.SetCurrentLength(len as u32).map_err(mf_err)?;
        buf.Unlock().map_err(mf_err)?;
    }
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

unsafe fn lock_buf(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
        .map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !data.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}

fn to_annex_b(raw: &[u8]) -> Vec<u8> {
    if raw.len() >= 4 && raw[0] == 0 && raw[1] == 0 && raw[2] == 0 && raw[3] == 1 {
        return raw.to_vec();
    }
    if raw.len() >= 3 && raw[0] == 0 && raw[1] == 0 && raw[2] == 1 {
        return raw.to_vec();
    }
    let mut out = Vec::with_capacity(raw.len() + 32);
    let mut i = 0usize;
    while i + 4 <= raw.len() {
        let n = u32::from_be_bytes([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]) as usize;
        i += 4;
        if n == 0 || i + n > raw.len() {
            break;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&raw[i..i + n]);
        i += n;
    }
    if out.is_empty() {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(raw);
    }
    out
}

/// 会话包装：open 失败则标记不可用，调用方走 JPEG。
///
/// P1：CPU（内存 NV12）与 GPU（D3D11 零拷贝）双模。码率变化不再立刻重开，
/// 统一记为「待重开」，下一次编码时（CPU/GPU 各自带上下文）执行——
/// GPU 重开需要 D3D 设备，只有 encode_gpu 时刻才有。
pub struct H264SessionEncoder {
    enc: Option<MfH264Encoder>,
    /// Q3：目标流标准。变化触发重开；HEVC 连续打不开自动回落 H.264
    /// （HEVC 只是优化档，不能像 GPU 故障那样整个会话降 JPEG）。
    codec: VideoCodec,
    /// 当前码率缩放百分比（25–100），由 RTT 自适应写入。
    scale_pct: u32,
    /// 🔴 **30fps 标定的宽度基准码率**（bit/s）。帧率抬升与自动缩放统一在
    /// [`Self::scaled_bitrate`] 里乘——这里绝不能存已含帧率因子的值，
    /// 否则重开时帧率因子被乘第二次（1080p120 重开后 20.8Mbps → 54Mbps，
    /// 2026-09-19 审查发现的 P1）。
    base_bitrate: u32,
    /// 时间戳步进用的 fps（fps120 档 120、fps60 档 60、其余 30）。
    fps: u32,
    /// true = 当前编码器处于 D3D11 零拷贝模式。
    gpu_mode: bool,
    /// 模式/码率/fps 变化后待重开（下次编码时执行）。
    reopen_needed: bool,
    /// GPU 打开连续失败次数（≥3 判定本机零拷贝不可用，不再尝试）。
    gpu_fail_streak: u32,
    /// Q3：HEVC 打开连续失败次数（≥2 判定本机 HEVC 不可用，回落 H.264）。
    hevc_fail_streak: u32,
    /// Q3：本会话已证实 HEVC 不可用（回落过）。置位后 SetCodec hevc 不再
    /// 触发重开——否则每帧「切 HEVC → 打不开 → 回 H.264」来回翻烧饼，
    /// 隔帧掉 JPEG。
    hevc_broken: bool,
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

    fn scaled_bitrate(&self) -> u32 {
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
        let nv12 = super::dxgi::bgra_to_nv12(bgra, ew, eh)?;
        enc.encode_nv12(&nv12)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avcc_to_annexb() {
        let avcc = [0u8, 0, 0, 3, 0x65, 0x11, 0x22];
        let b = to_annex_b(&avcc);
        assert_eq!(&b[0..4], &[0, 0, 0, 1]);
        assert_eq!(&b[4..], &[0x65, 0x11, 0x22]);
    }

    #[test]
    fn already_annexb() {
        let raw = [0u8, 0, 0, 1, 0x67, 0x42];
        assert_eq!(to_annex_b(&raw), raw.to_vec());
    }

    #[test]
    fn q4_4k60_h264_level必须抬到52() {
        // 4K60 = 32400 MB/帧 × 60 ≈ 194 万 MB/s：L5.1（983040）超规格约一倍
        assert_eq!(h264_level_for(3840, 2160, 60), 52);
        // 4K30 仍是 L5.1；1080p120 仍 5.1（D4）；1440p60 曾按 L5.0 超规格 → 5.1
        assert_eq!(h264_level_for(3840, 2160, 30), 51);
        assert_eq!(h264_level_for(1920, 1080, 120), 51);
        assert_eq!(h264_level_for(2560, 1440, 60), 51);
        // 低档不降级：1080p30 保持 4.2（兼容性优先，只升不降）
        assert_eq!(h264_level_for(1920, 1080, 30), 42);
        // 前端解码串同口径（Q4 的 uhd60 H.264 兜底路径）
        assert_eq!(webcodecs_codec_str(3840, 2160, 60), "avc1.640034");
    }

    #[test]
    fn q3_hevc解码串与标准名() {
        // level 按 luma 采样率取最小覆盖档（2026-09-19 审查 P2：旧二分把
        // 1080p60/1440p 压进 L4.0 的 66.7M MaxLumaSr，超规格 1.9~3.3 倍）
        assert_eq!(
            webcodecs_hevc_str(1920, 1080, 30),
            "hev1.1.6.L120.B0",
            "1080p30=62.2M ≤ L4.0 的 66.7M"
        );
        assert_eq!(
            webcodecs_hevc_str(1920, 1080, 60),
            "hev1.1.6.L123.B0",
            "1080p60=124M 超 L4.0，落 L4.1"
        );
        assert_eq!(
            webcodecs_hevc_str(2560, 1440, 60),
            "hev1.1.6.L150.B0",
            "1440p60=221M 落 L5.0"
        );
        assert_eq!(
            webcodecs_hevc_str(3840, 2160, 30),
            "hev1.1.6.L150.B0",
            "4K30=249M 落 L5.0"
        );
        assert_eq!(
            webcodecs_hevc_str(3840, 2160, 60),
            "hev1.1.6.L153.B0",
            "4K60=498M 落 L5.1"
        );
        assert_eq!(
            webcodecs_hevc_str(3840, 2160, 0),
            "hev1.1.6.L153.B0",
            "fps 未指定按 60 兜最坏——不能把解码端配在流规格之下"
        );
        assert_eq!(VideoCodec::of_str("hevc"), Some(VideoCodec::Hevc));
        assert_eq!(VideoCodec::of_str("h264"), Some(VideoCodec::H264));
        assert_eq!(VideoCodec::of_str("vp9"), None);
        assert_eq!(VideoCodec::H264.as_str(), "h264");
        assert_eq!(VideoCodec::Hevc.mf_subtype(), &MFVideoFormat_HEVC);
    }

    #[test]
    fn level_and_bitrate_follow_resolution() {
        assert_eq!(h264_level_for(1280, 720, 30), 40);
        assert_eq!(h264_level_for(1920, 1080, 30), 42);
        assert_eq!(h264_level_for(3840, 2160, 30), 51);
        // 审查 D4：高帧率必须抬 level——1080p120 超出 L4.2 宏块率 87%
        assert_eq!(h264_level_for(1920, 1080, 120), 51);
        assert_eq!(h264_level_for(1920, 1080, 60), 42, "1080p60 在 L4.2 内");
        assert_eq!(webcodecs_codec_str(3840, 2160, 30), "avc1.640033");
        assert_eq!(webcodecs_codec_str(1920, 1080, 120), "avc1.640033");
        assert!(bitrate_for_width(3840) >= 20_000_000);
        // 审查 D3：码率随帧率抬升——fps120 不能沿用 30fps 的表
        assert_eq!(fps_bitrate_factor(30), 100);
        assert_eq!(fps_bitrate_factor(60), 160);
        assert_eq!(fps_bitrate_factor(120), 260);
        assert_eq!(bitrate_for(1920, 30), bitrate_for_width(1920));
        assert!(bitrate_for(1920, 120) >= bitrate_for_width(1920) * 2);
    }

    /// 🔴 帧率因子只乘一次（2026-09-19 审查 P1）：base_bitrate 是 30fps 标定的
    /// 宽度基准，scaled_bitrate 在其上乘帧率因子与缩放。曾几何时 try_open 把
    /// bitrate_for(width, fps)（已含因子）存进 base_bitrate，任何一次重开
    /// （RTT 缩放 / SetBitratePct / 换档）都会把帧率因子乘第二次：
    /// 1080p120 应 20.8Mbps，实际 54Mbps，弱网降到 40% 也压不下来。
    #[test]
    fn 码率基准的帧率因子只乘一次() {
        let enc = H264SessionEncoder {
            enc: None,
            codec: VideoCodec::H264,
            scale_pct: 100,
            base_bitrate: bitrate_for_width(1920),
            fps: 120,
            gpu_mode: false,
            reopen_needed: false,
            gpu_fail_streak: 0,
            hevc_fail_streak: 0,
            hevc_broken: false,
        };
        // 1080p120：8M × 2.6 = 20.8M——不是 ×2.6² 的 54M
        assert_eq!(enc.scaled_bitrate(), 20_800_000);
        // 弱网缩放 40% 也要真的压到位
        let mut scaled = enc;
        scaled.scale_pct = 40;
        assert_eq!(scaled.scaled_bitrate(), 8_320_000);
    }
}
