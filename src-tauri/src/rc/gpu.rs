//! P1 — GPU 零拷贝路径：BGRA 捕获纹理 → `ID3D11VideoProcessor` 转 NV12 →
//! D3D11-aware 硬件 MFT 直接吃纹理。
//!
//! 为什么必须有这条路径：CPU 管线（读回 + CPU NV12 转换）单帧 4~20ms，
//! 120fps（8.3ms 预算）在物理上不可能。GPU 管线全程不碰显存读回：
//! 捕获纹理（DD 拷贝到自有 BGRA 纹理）→ VideoProcessor 色彩转换（~0.5ms）→
//! 编码器吃同一块显存里的 NV12。这是 60→120 的唯一钥匙，也是 4K 破 60 的前提。
//!
//! 🔴 颜色口径与 CPU 路径（`dxgi::bgra_to_nv12`）完全一致：
//! RGB full range → YCbCr **BT.709 limited**（Q1，2026-09-19：HD 内容业界
//! 标准矩阵，与浏览器对未标注 HD 流的解读一致）。两条路径口径必须一致。
//!
//! ⚠️ COM/D3D 对象非 Send：`MfH264Encoder` 已有 `unsafe impl Send` 的先例
//! （本进程 MTA + 会话任务串行访问），本模块对象只活在那个任务里，同规则。

#![cfg(target_os = "windows")]

use std::collections::HashMap;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
    DXGI_FORMAT_NV12, DXGI_RATIONAL,
};

/// BGRA → NV12 的 GPU 转换器。一个编码器会话一份。
///
/// 输入纹理按**地址**缓存 InputView（DD 重建/分辨率变化会换纹理，缓存自然失效
/// 重建；容量上限防异常增长）。输出 NV12 纹理常驻，转换后交给编码器包装。
pub struct GpuNv12Converter {
    video_device: ID3D11VideoDevice,
    video_ctx: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    out_tex: ID3D11Texture2D,
    out_view: ID3D11VideoProcessorOutputView,
    in_views: HashMap<isize, ID3D11VideoProcessorInputView>,
    width: u32,
    height: u32,
}

impl GpuNv12Converter {
    pub fn new(
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        w: u32,
        h: u32,
    ) -> Result<Self, String> {
        let (w, h) = ((w.max(64) & !1), (h.max(64) & !1));
        unsafe {
            let video_device: ID3D11VideoDevice = device.cast().map_err(|e| format!("VideoDevice：{e}"))?;
            let video_ctx: ID3D11VideoContext = ctx.cast().map_err(|e| format!("VideoContext：{e}"))?;
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                InputWidth: w,
                InputHeight: h,
                OutputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                OutputWidth: w,
                OutputHeight: h,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device
                .CreateVideoProcessorEnumerator(&desc)
                .map_err(|e| format!("VP 枚举器：{e}"))?;
            let processor = video_device
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|e| format!("VP 创建：{e}"))?;

            // NV12 输出纹理：VP 输出视图要求 BIND_RENDER_TARGET
            let tex_desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut out_tex: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&tex_desc, None, Some(&mut out_tex))
                .map_err(|e| format!("NV12 纹理：{e}"))?;
            let out_tex = out_tex.ok_or("NV12 纹理创建为空")?;
            let ov_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };            let out_view = {
                let mut v: Option<ID3D11VideoProcessorOutputView> = None;
                video_device
                    .CreateVideoProcessorOutputView(&out_tex, &enumerator, &ov_desc, Some(&mut v))
                    .map_err(|e| format!("VP 输出视图：{e}"))?;
                v.ok_or("VP 输出视图为空")?
            };

            // 颜色口径：与 CPU 路径一致（RGB full → BT.709 limited，Q1）。
            // ColorSpace1 在 ID3D11VideoContext1（Win8.1+）上；cast 失败说明
            // 驱动太老，零拷贝路径整体放弃（调用方回落 CPU 管线）。
            let video_ctx1: ID3D11VideoContext1 = video_ctx
                .cast()
                .map_err(|e| format!("VideoContext1：{e}"))?;
            // 这两个方法返回 void（无错误码），设置尽力而为
            video_ctx1.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            video_ctx1.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );

            Ok(Self {
                video_device,
                video_ctx,
                enumerator,
                processor,
                out_tex,
                out_view,
                in_views: HashMap::new(),
                width: w,
                height: h,
            })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// BGRA 纹理 → NV12 纹理（显存内）。返回的纹理归本转换器所有，
    /// 下一次 convert 会覆盖内容——编码器当帧消费完即弃。
    pub fn convert(&mut self, bgra: &ID3D11Texture2D) -> Result<ID3D11Texture2D, String> {
        let view = self.input_view(bgra)?;
        unsafe {
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(view)),
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };
            self.video_ctx
                .VideoProcessorBlt(&self.processor, &self.out_view, 0, &[stream])
                .map_err(|e| format!("VP 转换：{e}"))?;
        }
        Ok(self.out_tex.clone())
    }

    /// 输入视图按纹理地址缓存；纹理换了（DD 重建/分辨率变化）自动重建。
    fn input_view(&mut self, tex: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorInputView, String> {
        let key = tex.as_raw() as isize;
        if let Some(v) = self.in_views.get(&key) {
            return Ok(v.clone());
        }
        if self.in_views.len() > 8 {
            self.in_views.clear();
        }
        unsafe {
            let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: 0,
                    },
                },
            };
            let mut v: Option<ID3D11VideoProcessorInputView> = None;
            self.video_device
                .CreateVideoProcessorInputView(tex, &self.enumerator, &desc, Some(&mut v))
                .map_err(|e| format!("VP 输入视图：{e}"))?;
            let v = v.ok_or("VP 输入视图为空")?;
            self.in_views.insert(key, v.clone());
            Ok(v)
        }
    }
}

/// 编码能力探测（P1 门控 + P3 HEVC 探测）。进程内缓存——MFT 枚举与
/// 显示模式查询都是轻量 API，但设置页/控制帧会反复要，没必要每次重查。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct GpuEncodeCaps {
    /// 硬件 H.264 MFT 存在且 D3D11-aware（零拷贝路径的前提）。
    pub h264_gpu: bool,
    /// 硬件 HEVC MFT 存在（P3 实验档的前提）。
    pub hevc_hw: bool,
    /// 主显示器当前刷新率（Hz）。0 = 查不到（保守按 60 处理）。
    pub refresh_hz: u32,
    /// 在线显示器数量（fps120 档要求单屏捕获）。
    pub monitors: u32,
}

static CAPS: std::sync::OnceLock<GpuEncodeCaps> = std::sync::OnceLock::new();

pub fn encode_caps() -> GpuEncodeCaps {
    *CAPS.get_or_init(|| unsafe { probe_encode_caps() })
}

unsafe fn probe_encode_caps() -> GpuEncodeCaps {
    // MFTEnumEx 要求 COM 已初始化；探测进程内只跑一次，MTA 引用常驻即可
    let _ = windows::Win32::System::Com::CoInitializeEx(
        None,
        windows::Win32::System::Com::COINIT_MULTITHREADED,
    );
    let h264_gpu = hardware_mft_d3d11_aware(&windows::Win32::Media::MediaFoundation::MFVideoFormat_H264);
    let hevc_hw =
        hardware_mft_d3d11_aware(&windows::Win32::Media::MediaFoundation::MFVideoFormat_HEVC);
    let refresh_hz = primary_refresh_hz();
    let monitors = windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
        windows::Win32::UI::WindowsAndMessaging::SM_CMONITORS,
    ).max(0) as u32;
    let caps = GpuEncodeCaps {
        h264_gpu,
        hevc_hw,
        refresh_hz,
        monitors,
    };
    log::info!(
        "[RC] 编码能力探测：h264_gpu={} hevc={} 主屏刷新={}Hz 显示器={}",
        caps.h264_gpu,
        caps.hevc_hw,
        caps.refresh_hz,
        caps.monitors
    );
    caps
}

/// 枚举硬件编码 MFT（NV12→codec），返回第一台是否 D3D11-aware。
/// 只查属性，不 ActivateObject——探测要便宜。
unsafe fn hardware_mft_d3d11_aware(subtype: &windows::core::GUID) -> bool {
    use windows::Win32::Media::MediaFoundation::*;
    let in_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *subtype,
    };
    let out_info_nv12 = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    let _ = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE,
        Some(&in_info),
        Some(&out_info_nv12),
        &mut acts,
        &mut count,
    );
    if count == 0 || acts.is_null() {
        return false;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let aware = match slice.first() {
        Some(Some(act)) => match act.ActivateObject::<IMFTransform>() {
            Ok(t) => match t.GetAttributes() {
                Ok(attrs) => attrs
                    .GetUINT32(&MF_SA_D3D11_AWARE)
                    .map(|v| v != 0)
                    .unwrap_or(false),
                Err(_) => false,
            },
            Err(_) => false,
        },
        _ => false,
    };
    for a in slice.iter().flatten() {
        let _ = a.ShutdownObject();
    }
    windows::Win32::System::Com::CoTaskMemFree(Some(acts as _));
    aware
}

/// 主显示器刷新率（`EnumDisplaySettingsW` 当前模式）。查不到返回 0。
unsafe fn primary_refresh_hz() -> u32 {
    display_refresh_hz(None)
}

/// 审查 M2：caps 的刷新率门槛过去只看主屏——抓副屏时两头都不准
/// （副 240Hz/主 60Hz 漏卖 fps120；副 60Hz/主 144Hz 虚卖）。
/// 按 `list_monitors` 的同一枚举顺序（索引即序号）找到目标屏的设备名再查。
/// `index < 0` = 主屏（与 `primary_refresh_hz` 同义）。
pub fn refresh_hz_for_monitor(index: i32) -> u32 {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    };
    struct Ctx {
        index: i32,
        count: i32,
        /// 命中屏的 Win32 设备名（szDevice，NUL 结尾）；全 0 = 未命中。
        device: [u16; 32],
    }
    unsafe extern "system" fn cb(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, lp: LPARAM) -> BOOL {
        let ctx = &mut *(lp.0 as *mut Ctx);
        let idx = ctx.count;
        ctx.count += 1;
        let mut mi = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        // 标准技巧：MONITORINFOEXW 以 MONITORINFO 开头，按基类指针传入
        if GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool()
            && ctx.index == idx
        {
            ctx.device = mi.szDevice;
        }
        BOOL(1)
    }
    let mut ctx = Ctx {
        index,
        count: 0,
        device: [0; 32],
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(cb),
            LPARAM(&mut ctx as *mut Ctx as isize),
        );
        let len = ctx.device.iter().position(|c| *c == 0).unwrap_or(32);
        if len == 0 {
            return primary_refresh_hz();
        }
        display_refresh_hz(Some(&String::from_utf16_lossy(&ctx.device[..len])))
    }
}

/// 按 Win32 设备名查当前显示模式的刷新率；`None`/空 = 主显示设备。
unsafe fn display_refresh_hz(device: Option<&str>) -> u32 {
    use windows::Win32::Graphics::Gdi::{DEVMODEW, DM_DISPLAYFREQUENCY, ENUM_CURRENT_SETTINGS};
    let mut dm = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    let dev_wide: Option<Vec<u16>> = device.map(|s| s.encode_utf16().chain([0]).collect());
    let ok = match dev_wide.as_deref() {
        Some(w) => {
            windows::Win32::Graphics::Gdi::EnumDisplaySettingsW(
                windows::core::PCWSTR(w.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut dm,
            )
            .as_bool()
        }
        None => windows::Win32::Graphics::Gdi::EnumDisplaySettingsW(
            windows::core::PCWSTR::null(),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        )
        .as_bool(),
    };
    if ok {
        let has = dm.dmFields & DM_DISPLAYFREQUENCY;
        if has.0 != 0 && dm.dmDisplayFrequency >= 10 {
            return dm.dmDisplayFrequency.min(1000);
        }
    }
    0
}
