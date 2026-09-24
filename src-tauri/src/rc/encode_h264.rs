//! R4.1 — Media Foundation 硬件 H.264 编码器。
//!
//! 优先硬件 MFT；不可用则整段会话回退 JPEG。输入 NV12，输出 Annex-B。
//!
//! R5.B：profile 用 **High(100)**，level 随分辨率抬升（最高 5.1 覆盖 4K@30），
//! 码率按宽查表。打开尺寸跟抓屏走，不再写死 1280×720。
//!
//! ⚠️ 2026-09-21 拆分：**MFT 选型与探测**（枚举/试编/媒体类型构造）已移到
//! [`super::mft_pick`]；本文件只管「编码器怎么用」（open / encode / drain）。
//! 两个文件的变更理由不同——前者随显卡与驱动演进，后者随 MF 协议演进。

#![cfg(target_os = "windows")]

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
// `CoInitializeEx` / `COINIT_MULTITHREADED` 不再从这里透出：COM 初始化已收口到
// `rc::mft_diag::ensure_mta_quiet`（被拒时必须留证据）。子模块经 `use super::*`
// 也拿不到它们了，改走收口函数 —— 这正是防「第 N 处调用点又悄悄丢返回值」的手段。
use windows::Win32::System::Com::CoUninitialize;

use super::mft_pick::{
    adapter_luid_of, create_h264_mft, create_video_type, lock_buf, make_dxgi_sample, make_sample,
    pack_ratio, pick_output_type,
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
///
/// 2026-09-22 补 144/165（fps144/fps165 档）：沿 60→120 的斜率（每 +60fps
/// +100 点）外推——144→300、165→335。1080p165 ≈ 26.8Mbps（线上含 FEC
/// ≈ 33Mbps），千兆有线局域网无压力；跨网仍靠 scale_pct 自适应往下压。
/// 240 及以上刻意不做：编码预算 4.2ms 贴硬编极限、1080p240 贴死 L5.2
/// 宏块率上限（1.96M / 2.07M），受众极窄——档位表到 165 为止。
pub fn fps_bitrate_factor(fps: u32) -> u64 {
    match fps {
        0..=30 => 100,
        31..=60 => 160,
        61..=120 => 260,
        121..=144 => 300,
        _ => 335,
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

mod mf;
mod session;

pub use mf::*;
pub use session::*;
// to_annex_b 由 mf 模块实现；给测试与会话编码器一个父模块绑定。
pub(in crate::rc) use mf::mf_err;
#[cfg(test)]
use mf::to_annex_b;

#[cfg(test)]
mod tests;