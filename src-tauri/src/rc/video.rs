//! 远程协助画面帧（R1/R3）：截屏 → 降采样 → JPEG；R3 加脏矩形与自适应码率。
//!
//! 同一条 bi-stream：
//! - JSON 以 `{` 开头（信令 / 脏矩形元数据）
//! - JPEG 以 `FF D8` 开头（整帧或裁剪块）

use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder};
use std::sync::Mutex;

pub const MAX_JPEG_BYTES: usize = 2 * 1024 * 1024;
/// H.264 单包上限：4K 关键帧可 >2MB，放宽到 8MB（R5.B）。
pub const MAX_H264_BYTES: usize = 8 * 1024 * 1024;
pub const TARGET_MAX_W: u32 = 1280;
pub const JPEG_QUALITY_DEFAULT: u8 = 55;
pub const JPEG_QUALITY_MIN: u8 = 35;
pub const JPEG_QUALITY_MAX: u8 = 75;
/// 静止判定：每 64×64 块平均绝对差 < 此值视为未变。
const TILE: u32 = 64;
const TILE_DIFF_THRESHOLD: u8 = 8;
/// 脏块占比低于此值才发裁剪；否则整帧。
const DIRTY_RATIO_SEND: f32 = 0.35;
/// 强制关键帧间隔（帧数）。
const KEYFRAME_EVERY: u32 = 30;
/// 静止区高保真回补：画面静止持续这么久才发（一次性，直到画面再变）。
/// Q8：H264 路径的静止 IDR 精修（inbound.rs）也用这个阈值，两路口径一致。
pub(crate) const REFINE_AFTER_MS: i64 = 300;
/// 回补帧的 JPEG 质量——接近视觉无损，远小于 PNG。
const REFINE_QUALITY: u8 = 95;

/// 画质档（被控端编码参数）。
///
/// 方案 A「伪 4K」：`ultra` 编码宽 **2560**（约 2.5K），不是原生 4K；
/// 真 4K 主屏硬编见规划文档 R5（方案 B）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeProfile {
    pub max_w: u32,
    pub interval_ms: u64,
    /// Q3/Q4：本档位偏好的编码标准。true = 硬编 HEVC（打不开自动回落 H.264）。
    /// 目前只有 uhd60 置位：4K60 的 H.264 要 L5.2（解码端兼容性差），HEVC
    /// L5.1 即覆盖且同画质省约一半带宽。其余档位走 H.264（生态最稳）。
    pub hevc: bool,
    /// P1/G5：本档是否该走 D3D11 零拷贝路径。实际走不走还看「单输出」与「GPU 路径
    /// 是否已判死」——三条判据集中在 `inbound::want_zero_copy`。true 只给 fps120 与
    /// uhd60：CPU 管线每帧的读回 + 色彩转换在这两档吃不下（1080p60 CPU 能扛，不置位）。
    pub gpu: bool,
    pub q_min: u8,
    pub q_max: u8,
    pub q_default: u8,
    /// 自适应：近 8 帧均值超过此值则降 quality。
    pub adapt_down: usize,
    /// 自适应：近 8 帧均值低于此值则升 quality。
    pub adapt_up: usize,
}

impl EncodeProfile {
    /// 按档位名取 profile；未知名字回落 `balanced`。
    ///
    /// 🔴 刻意不叫 `from_str`：那会与 `std::str::FromStr::from_str` 撞名，
    /// 而本函数不做解析失败（恒返回 `Self`），语义不同，改名避免误用。
    pub fn of_name(s: &str) -> Self {
        match s {
            "sharp" => Self {
                max_w: 1920,
                interval_ms: 66,
                hevc: false,
                gpu: false,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "ultra" => Self {
                max_w: 2560,
                interval_ms: 80,
                hevc: false,
                gpu: false,
                q_min: 50,
                q_max: 85,
                q_default: 72,
                adapt_down: 700_000,
                adapt_up: 150_000,
            },
            // uhd：主屏硬编走原生分辨率；JPEG 兜底仍按 2.5K 控带宽（R5.B）
            "uhd" => Self {
                max_w: 2560,
                interval_ms: 50,
                hevc: false,
                gpu: false,
                q_min: 55,
                q_max: 85,
                q_default: 75,
                adapt_down: 800_000,
                adapt_up: 180_000,
            },
            // uhd60（Q4/G5）：原生分辨率 60fps——4K 屏即 4K60。硬编专属体感档：
            // UI 门槛 = 硬件 MFT + HEVC MFT（4K60 的 H.264 要 L5.2，解码端
            // 兼容性差；HEVC L5.1 即覆盖，且同画质省一半带宽）。JPEG 兜底按 2.5K。
            // G5：本档也走 D3D11 零拷贝——4K 每帧 CPU 读回 + BGRA→NV12 转换
            // （约 33MB/帧 × 60）是 CPU 管线跑不到 60fps 的根本原因；抓取纹理
            // 不出显存才谈得上「持续 60」。单输出条件与 fps120 同一门控。
            "uhd60" => Self {
                max_w: 2560,
                interval_ms: 16,
                hevc: true,
                gpu: true,
                q_min: 55,
                q_max: 85,
                q_default: 75,
                adapt_down: 800_000,
                adapt_up: 180_000,
            },
            // fps60：高帧率档（硬编专属体感档）——16ms 节拍 + 提帧上限 60fps。
            // 1080p 全速；4K 硬编跑不满时由编码耗时自适应降频兜底（P1-7）。
            "fps60" => Self {
                max_w: 1920,
                interval_ms: 16,
                hevc: false,
                gpu: false,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            // fps120：高帧率+（P1 零拷贝档，G5 起与 uhd60 共用同一门控）——8ms 节拍。
            // CPU 管线跑不到这个节拍，跑不满时 pace_scale 自动降频
            //（8→16/24/32ms = 120/60/40/30fps）。
            // UI 门槛：单屏 + 硬件 MFT + D3D11 零拷贝路径 + 高刷屏，缺一不显示。
            "fps120" => Self {
                max_w: 1920,
                interval_ms: 8,
                hevc: false,
                gpu: true,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            // fps144 / fps165（2026-09-22）：电竞屏档——7ms / 6ms 节拍，与 fps120
            // 同一零拷贝门控 + 各自的刷新率下限（144/165Hz，见 set_stream_quality）。
            // 1080p144/165 超出 H.264 L5.1 宏块率，`h264_level_for` 按宏块率自动
            // 抬 L5.2；码率系数 300/335（`fps_bitrate_factor`，1080p165 线上
            // 含 FEC ≈ 33Mbps）。240 及以上刻意不做：编码预算 4.2ms 贴硬编
            // 极限、宏块率贴死 L5.2，受众极窄——档位表到 165 为止。
            "fps165" => Self {
                max_w: 1920,
                interval_ms: 6,
                hevc: false,
                gpu: true,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "fps144" => Self {
                max_w: 1920,
                interval_ms: 7,
                hevc: false,
                gpu: true,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "smooth" => Self {
                max_w: 960,
                interval_ms: 100,
                hevc: false,
                gpu: false,
                q_min: 25,
                q_max: 55,
                q_default: 40,
                adapt_down: 150_000,
                adapt_up: 30_000,
            },
            // balanced（默认）
            _ => Self {
                max_w: TARGET_MAX_W,
                interval_ms: 100,
                hevc: false,
                gpu: false,
                q_min: JPEG_QUALITY_MIN,
                q_max: JPEG_QUALITY_MAX,
                q_default: JPEG_QUALITY_DEFAULT,
                adapt_down: 220_000,
                adapt_up: 50_000,
            },
        }
    }
}

/// 高帧率能力档表（2026-09-22）：档名 → (目标 fps, 被控端刷新率下限 Hz)。
///
/// 「跑不到的档不卖」：caps 上报（`fps_high`，inbound_tasks）与 API 防设
/// （`set_stream_quality`）共用这张表——判据写两遍必漂移。按 fps 从高到低
/// 排列，caps 判定取第一个刷新率达标的档。
/// 🔴 240 及以上刻意不进表：编码预算 4.2ms 贴硬编极限、1080p240 宏块率贴死
/// L5.2（1.96M / 2.07M MB/s），受众极窄——档位表到 165 为止。
pub const HIGH_FPS_LADDER: [(&str, u32, u32); 3] =
    [("fps165", 165, 165), ("fps144", 144, 144), ("fps120", 120, 100)];

/// 档位对应的刷新率下限；非高帧率档返回 None（不走能力校验）。
pub fn high_fps_min_hz(quality: &str) -> Option<u32> {
    HIGH_FPS_LADDER
        .iter()
        .find(|(q, _, _)| *q == quality)
        .map(|(_, _, hz)| *hz)
}

impl Default for EncodeProfile {
    fn default() -> Self {
        Self::of_name("balanced")
    }
}

impl EncodeProfile {
    /// P1/G5：本条会话是否走 D3D11 零拷贝路径。三条判据，缺一回落 CPU 管线：
    /// ① 档位本身吃不下 CPU 管线（`gpu`：fps120 的 8ms 节拍 / uhd60 的 4K60）；
    /// ② **单输出**——多屏拼接要在 GPU 侧跨屏合成，没有这条路（`dxgi::grab_gpu` 也拒）；
    /// ③ 本会话 GPU 路径没被判死（连续 3 次打不开或编码失败会置位）。
    ///
    /// 做成纯函数/方法是因为**判据错了不会崩**——只会静默跑 CPU 管线，表现为
    /// 「档位给了但跑不满」，这种问题在双机手测里极难定位（见 11.7 的教训）。
    pub fn wants_zero_copy(&self, virtual_screen: bool, gpu_disabled: bool) -> bool {
        self.gpu && !virtual_screen && !gpu_disabled
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCodec {
    Jpeg,
    H264,
    /// Q3：HEVC Annex-B（Main profile）。与 H264 同一条「元数据 + 裸流」通道，
    /// 仅编码标准不同。
    Hevc,
}

impl FrameCodec {
    /// IPC 批量帧头里的 `codec u8`。前端 `parseFrameBatch` 按同一张表读。
    pub fn as_u8(self) -> u8 {
        match self {
            Self::Jpeg => 0,
            Self::H264 => 1,
            Self::Hevc => 2,
        }
    }

    pub fn of_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Jpeg),
            1 => Some(Self::H264),
            2 => Some(Self::Hevc),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
    pub at_ms: i64,
    /// true = 整帧；false = 仅更新区域（由 rect 描述）。
    pub full: bool,
    /// 脏矩形（整帧坐标系）；`full=true` 时为 None。
    pub rect: Option<DirtyRect>,
    /// 编码类型：JPEG / H.264 Annex-B / HEVC Annex-B（Q3）。
    pub codec: FrameCodec,
    /// H.264 关键帧。
    pub key: bool,
    /// P0-2 延迟分段：采集耗时（ms）。0 = 未统计。
    pub cap_ms: u16,
    /// P0-2 延迟分段：编码耗时（ms）。0 = 未统计。
    pub enc_ms: u16,
}

/// 脏矩形（降采样坐标系）。
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct DirtyRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// 自适应质量状态（被控端每会话一份）。
pub struct EncoderState {
    quality: u8,
    last_rgb: Option<(u32, u32, Vec<u8>)>,
    frame_idx: u32,
    recent_sizes: Vec<usize>,
    profile: EncodeProfile,
    /// true=虚拟屏；false=仅主屏（`monitor < 0` 时生效）。
    virtual_screen: bool,
    /// >=0 时抓指定显示器；-1 跟随 virtual_screen。
    monitor: i32,
    /// 最近一次画面真正变化（非回补帧）的时刻；0 = 尚无基准。
    last_change_ms: i64,
    /// 静止期高保真回补已发（画面再变才重置）。
    refined: bool,
}

impl EncoderState {
    pub fn new() -> Self {
        Self::with_profile(EncodeProfile::default(), true)
    }

    pub fn with_profile(profile: EncodeProfile, virtual_screen: bool) -> Self {
        Self {
            quality: profile.q_default,
            last_rgb: None,
            frame_idx: 0,
            recent_sizes: Vec::new(),
            profile,
            virtual_screen,
            monitor: -1,
            last_change_ms: 0,
            refined: false,
        }
    }

    pub fn quality(&self) -> u8 {
        self.quality
    }

    pub fn profile(&self) -> &EncodeProfile {
        &self.profile
    }

    pub fn virtual_screen_flag(&self) -> bool {
        self.virtual_screen
    }

    pub fn monitor(&self) -> i32 {
        self.monitor
    }

    /// 会话中远程改档：换 profile / 截取范围，质量回到新档默认。
    pub fn apply_profile(&mut self, profile: EncodeProfile, virtual_screen: bool) {
        self.profile = profile;
        self.virtual_screen = virtual_screen;
        self.monitor = -1;
        self.quality = profile.q_default;
        self.last_rgb = None;
        self.last_change_ms = 0;
        self.refined = false;
    }

    pub fn apply_monitor(&mut self, monitor: i32) {
        self.monitor = monitor;
        self.virtual_screen = monitor < 0 && self.virtual_screen;
        self.last_rgb = None;
        self.last_change_ms = 0;
        self.refined = false;
    }

    fn adapt(&mut self, size: usize) {
        self.recent_sizes.push(size);
        if self.recent_sizes.len() < 8 {
            return;
        }
        let avg: usize = self.recent_sizes.iter().sum::<usize>() / self.recent_sizes.len();
        self.recent_sizes.clear();
        // 阈值随档位走：ultra/清晰 画面更大，套用 1280 的 220KB 会一直误降质
        if avg > self.profile.adapt_down && self.quality > self.profile.q_min {
            self.quality = self.quality.saturating_sub(5).max(self.profile.q_min);
        } else if avg < self.profile.adapt_up && self.quality < self.profile.q_max {
            self.quality = (self.quality + 3).min(self.profile.q_max);
        }
    }
}

impl Default for EncoderState {
    fn default() -> Self {
        Self::new()
    }
}

/// 一帧编码结果：可能是整帧，也可能是脏矩形。
pub struct Encoded {
    /// 脏矩形时为 Some；整帧为 None。
    pub rect: Option<DirtyRect>,
    /// true = 静止期高保真回补帧（越看越清晰）；不计入码控统计。
    pub refine: bool,
    pub frame: VideoFrame,
}

fn is_jpeg_magic(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == 0xFF && b[1] == 0xD8
}

fn is_json_magic(b: &[u8]) -> bool {
    b.first() == Some(&b'{')
}

/// 发起端合成后再编码给前端用的简单路径（无脏矩形状态）。
pub fn encode_rgba_to_jpeg_simple(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<VideoFrame, String> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("像素数据构造失败")?;
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut buf = Vec::with_capacity(96 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 70)
        .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    Ok(VideoFrame {
        width,
        height,
        jpeg: buf,
        at_ms: chrono::Utc::now().timestamp_millis(),
        full: true,
        rect: None,
        codec: FrameCodec::Jpeg,
        key: true,
        cap_ms: 0,
        enc_ms: 0,
    })
}

mod encode;
mod compositor;
mod wire;

pub use encode::*;
pub use compositor::*;
pub use wire::*;

#[cfg(test)]
use encode::tile_dirty;

#[cfg(test)]
mod tests;